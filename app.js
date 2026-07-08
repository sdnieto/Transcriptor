// ==========================================
// ESTADO DE LA APP
// ==========================================
let isListening = false;
let savedHistory = [];
let finalTranscripts = [];
let mediaRecorder = null;
let socket = null;
let audioContext = null;
let mixedStream = null;
let localStream = null;
let systemStream = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000; // ms

// Métricas de latencia
let lastMessageTime = 0;
let currentLatency = 0;

// Anti-duplicados: Deepgram a veces envía dos mensajes "is_final: true"
// para el mismo fragmento de habla (uno por micro-pausa, otro al cerrar
// el turno). Guardamos el último texto agregado y su hora para ignorar
// repeticiones que llegan dentro de una ventana corta.
let lastAddedText = '';
let lastAddedTime = 0;
const DUPLICATE_WINDOW_MS = 4000;

// ==========================================
// ELEMENTOS DEL DOM
// ==========================================
const btnToggle = document.getElementById('btn-toggle');
const btnText = document.getElementById('btn-text');
const micIcon = document.getElementById('mic-icon');
const statusText = document.getElementById('status-text');
const container = document.getElementById('transcript-container');
const emptyState = document.getElementById('empty-state');
const interimDiv = document.getElementById('interim-text');
const interimContent = document.getElementById('interim-content');
const historyList = document.getElementById('history-list');
const latencyContainer = document.getElementById('latency-container');
const latencyDisplay = document.getElementById('latency-display');

// ==========================================
// VALIDACIÓN DE COMPATIBILIDAD DE NAVEGADOR
// ==========================================
function validateBrowserSupport() {
    const checks = {
        mediaDevices: !!navigator.mediaDevices?.getUserMedia,
        displayMedia: !!navigator.mediaDevices?.getDisplayMedia,
        audioContext: !!(window.AudioContext || window.webkitAudioContext),
        webSocket: typeof WebSocket !== 'undefined',
        storage: typeof chrome?.storage !== 'undefined'
    };

    const allSupported = Object.values(checks).every(v => v);

    if (!allSupported) {
        const missing = Object.entries(checks).filter(([_, v]) => !v).map(([k]) => k).join(', ');
        showError(`Navegador incompatible. Falta soporte para: ${missing}. Requiere Chrome 72+`);
        btnToggle.disabled = true;
        btnToggle.textContent = 'Navegador no compatible';
        return false;
    }

    statusText.textContent = 'Listo para iniciar';
    return true;
}

document.addEventListener('DOMContentLoaded', validateBrowserSupport);

// ==========================================
// CARGAR HISTORIAL DE CHROME STORAGE
// ==========================================
chrome.storage.local.get(['fonax_history'], (result) => {
    if (result.fonax_history) savedHistory = result.fonax_history;
});

// ==========================================
// FUNCIONES DE LATENCIA
// ==========================================
function updateLatency(ms) {
    currentLatency = ms;
    
    if (isListening) {
        latencyContainer.classList.remove('hidden');
        latencyDisplay.textContent = `${ms}ms`;
        
        latencyDisplay.classList.remove('latency-good', 'latency-ok', 'latency-slow');
        if (ms < 200) {
            latencyDisplay.classList.add('latency-good');
            statusText.textContent = `Escuchando (${ms}ms)`;
        } else if (ms < 500) {
            latencyDisplay.classList.add('latency-ok');
            statusText.textContent = `Escuchando - latencia: ${ms}ms`;
        } else {
            latencyDisplay.classList.add('latency-slow');
            statusText.textContent = `⚠️ Latencia alta: ${ms}ms`;
        }
    }
}

// ==========================================
// INICIAR ESCUCHA
// ==========================================
async function startListening() {
    try {
        if (!validateBrowserSupport()) return;

        emptyState.classList.add('hidden');
        statusText.textContent = 'Solicitando permisos...';
        btnToggle.disabled = true;

        // 1. Capturar micrófono (Agente)
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ 
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        } catch (err) {
            throw new Error('Permiso de micrófono denegado. Verifica la configuración del navegador.');
        }

        // 2. Capturar pestaña de Chrome (Cliente) - CORREGIDO: preferCurrentTab: false
        try {
            systemStream = await navigator.mediaDevices.getDisplayMedia({
                video: { cursor: 'never', frameRate: { ideal: 1 } },
                audio: true,
                preferCurrentTab: false
            });
        } catch (err) {
            localStream.getTracks().forEach(t => t.stop());
            throw new Error('Cancelaste la selección o faltan permisos.');
        }

        // Validar audio de pestaña
        if (systemStream.getAudioTracks().length === 0) {
            localStream.getTracks().forEach(t => t.stop());
            systemStream.getTracks().forEach(t => t.stop());
            throw new Error('Audio de pestaña no detectado. ¿Marcaste "Compartir audio de la pestaña"?');
        }

        // 3. MAGIA MULTICANAL (ESTÉREO) - WEB AUDIO API
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        const micSource = audioContext.createMediaStreamSource(localStream);
        const sysSource = audioContext.createMediaStreamSource(systemStream);
        
        const merger = audioContext.createChannelMerger(2);
        micSource.connect(merger, 0, 0);  // Micrófono → Canal izquierdo
        sysSource.connect(merger, 0, 1);  // Sistema → Canal derecho
        
        const destination = audioContext.createMediaStreamDestination();
        destination.channelCount = 2;
        merger.connect(destination);
        
        mixedStream = destination.stream;

        // Apagar video
        systemStream.getVideoTracks().forEach(track => track.stop());

        // Crear el MediaRecorder UNA SOLA VEZ, independiente del ciclo de
        // conexión/reconexión del WebSocket. Antes se creaba uno nuevo cada
        // vez que el socket se abría (incluyendo reconexiones), y el anterior
        // quedaba huérfano pero seguía enviando audio, duplicando la transcripción.
        //
        // FIX: audioBitsPerSecond estaba en 16000 (16kbps). A ese bitrate tan
        // bajo, Chrome fuerza un downmix a MONO al codificar Opus, aunque el
        // ChannelMergerNode sí esté separando mic (canal 0) y sistema (canal 1)
        // antes de llegar aquí. Resultado: los dos canales se funden en uno
        // solo justo en la codificación, y todo termina etiquetado igual
        // (por eso tu voz y el audio de YouTube salían "en el mismo canal").
        // Subimos el bitrate a 128kbps para que Chrome conserve el estéreo.
        mediaRecorder = new MediaRecorder(mixedStream, {
            mimeType: 'audio/webm;codecs=opus',
            audioBitsPerSecond: 128000
        });

        mediaRecorder.addEventListener('dataavailable', event => {
            if (event.data.size > 0 && socket && socket.readyState === WebSocket.OPEN) {
                lastMessageTime = Date.now();
                socket.send(event.data);
            }
        });

        mediaRecorder.addEventListener('error', (event) => {
            console.error('MediaRecorder error:', event.error);
            showError('Error en grabación de audio');
        });

        // Actualizar interfaz
        isListening = true;
        reconnectAttempts = 0;
        lastAddedText = '';
        lastAddedTime = 0;
        btnToggle.classList.replace('bg-blue-600', 'bg-red-100');
        btnToggle.classList.replace('text-white', 'text-red-700');
        btnToggle.classList.replace('hover:bg-blue-700', 'hover:bg-red-200');
        btnToggle.classList.add('recording-pulse');
        btnToggle.disabled = false;
        btnText.textContent = 'Detener Transcripción';
        micIcon.classList.replace('fa-microphone', 'fa-stop');
        statusText.textContent = 'Conectando a Deepgram...';
        statusText.classList.add('text-red-500');

        connectToDeepgram(mixedStream);

        if (systemStream.getVideoTracks().length > 0) {
            systemStream.getVideoTracks()[0].onended = () => {
                if (isListening) {
                    showError('Dejaste de compartir la pestaña');
                    stopListening();
                }
            };
        }

    } catch (err) {
        console.error('Error al iniciar:', err);
        showError(err.message);
        stopListening();
    }
}

// ==========================================
// CONECTAR A DEEPGRAM
// ==========================================
function connectToDeepgram(stream) {
    try {
        chrome.runtime.sendMessage({ action: 'getDeepgramToken' }, (response) => {
            if (!response || !response.token) {
                showError('Error al obtener credenciales de Deepgram');
                stopListening();
                return;
            }

            socket = new WebSocket(response.wsUrl, ['token', response.token]);

            socket.onopen = () => {
                try {
                    statusText.textContent = 'Conectado a Deepgram';
                    statusText.classList.remove('text-red-500');
                    statusText.classList.add('text-green-500');

                    // NOTA: ya no se envía un mensaje 'Configure' aquí. Los parámetros
                    // (multichannel, model, language, smart_format) ya vienen en la URL
                    // del WebSocket (ver background.js). Enviarlos otra vez era redundante
                    // y podía provocar que Deepgram reiniciara el pipeline de transcripción.

                    // El MediaRecorder ya fue creado en startListening() y persiste entre
                    // reconexiones. Solo lo arrancamos si todavía no está grabando, para
                    // no crear una segunda grabadora enviando el mismo audio.
                    if (mediaRecorder && mediaRecorder.state === 'inactive') {
                        mediaRecorder.start(250);
                    }
                    reconnectAttempts = 0;

                } catch (err) {
                    showError('Error al iniciar grabación');
                    stopListening();
                }
            };

            socket.onmessage = (message) => {
                try {
                    const received = JSON.parse(message.data);

                    if (lastMessageTime > 0) updateLatency(Date.now() - lastMessageTime);

                    if (received.type === 'Results') {
                        const alternatives = received.channel?.alternatives || [];
                        if (alternatives.length === 0) return;

                        const transcript = alternatives[0].transcript;
                        if (!transcript) return;

                        // FIX: Deepgram con multichannel=true devuelve channel_index
                        // como un ARREGLO (ej. [0] o [1]), no como un número. Antes
                        // "received.channel_index || 0" guardaba el arreglo completo,
                        // y como un arreglo nunca es === 0, TODO se etiquetaba como
                        // "Cliente" sin importar el canal real. Aquí extraemos el
                        // primer valor numérico del arreglo (o el número directo si
                        // ya viniera así).
                        const rawChannel = received.channel_index;
                        const canalIndex = Array.isArray(rawChannel) ? rawChannel[0] : (typeof rawChannel === 'number' ? rawChannel : 0);

                        if (received.is_final) {
                            // FIX duplicados: Deepgram puede emitir dos mensajes
                            // is_final:true seguidos para el mismo fragmento de
                            // habla (una micro-pausa interna y luego el cierre real
                            // del turno). Si el texto es idéntico al último agregado
                            // hace pocos segundos, lo ignoramos.
                            const normalized = transcript.trim().toLowerCase();
                            const now = Date.now();
                            if (normalized === lastAddedText && (now - lastAddedTime) < DUPLICATE_WINDOW_MS) {
                                interimDiv.classList.add('hidden');
                                return;
                            }
                            lastAddedText = normalized;
                            lastAddedTime = now;

                            const time = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
                            addFinalTranscript(time, transcript, canalIndex);
                            interimDiv.classList.add('hidden');
                        } else {
                            interimContent.textContent = transcript;
                            interimDiv.classList.remove('hidden');
                            container.scrollTop = container.scrollHeight;
                        }
                    }
                } catch (err) { console.error('Error procesando mensaje:', err); }
            };

            socket.onclose = () => {
                statusText.classList.remove('text-green-500');
                
                if (isListening && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    statusText.textContent = `Reconectando (intento ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
                    statusText.classList.add('text-yellow-500');
                    
                    setTimeout(() => { if (isListening) connectToDeepgram(stream); }, RECONNECT_DELAY);
                } else if (isListening) {
                    statusText.textContent = 'Desconectado (máximos reintentos alcanzados)';
                    statusText.classList.add('text-red-500');
                    stopListening();
                }
            };

            socket.onerror = (error) => {
                console.error('WebSocket Error:', error);
                statusText.textContent = 'Error de conexión con IA';
                statusText.classList.add('text-red-500');
                showError('Error al conectar con Deepgram. Verifica tu conexión.');
            };

        });
    } catch (err) {
        console.error('Error conectando a Deepgram:', err);
        showError('Error al conectar con el servicio de IA');
        stopListening();
    }
}

// ==========================================
// DETENER ESCUCHA
// ==========================================
function stopListening() {
    isListening = false;
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (e) {}
    }
    
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (systemStream) systemStream.getTracks().forEach(t => t.stop());
    if (audioContext && audioContext.state !== 'closed') audioContext.close();

    btnToggle.classList.replace('bg-red-100', 'bg-blue-600');
    btnToggle.classList.replace('text-red-700', 'text-white');
    btnToggle.classList.replace('hover:bg-red-200', 'hover:bg-blue-700');
    btnToggle.classList.remove('recording-pulse');
    btnToggle.disabled = false;
    btnText.textContent = 'Iniciar Transcripción';
    micIcon.classList.replace('fa-stop', 'fa-microphone');
    statusText.textContent = 'Pausado';
    statusText.classList.remove('text-red-500', 'text-green-500', 'text-yellow-500');
    interimDiv.classList.add('hidden');
    latencyContainer.classList.add('hidden');

    if (finalTranscripts.length === 0) emptyState.classList.remove('hidden');
}

// ==========================================
// AGREGAR TRANSCRIPCIÓN FINAL
// ==========================================
function addFinalTranscript(time, text, canalIndex) {
    if (!text || text.trim() === '') return;
    
    const isAgent = (canalIndex === 0 || canalIndex === undefined);
    const speakerName = isAgent ? "Tú (Agente)" : "Cliente";
    
    finalTranscripts.push(`[${time}] ${speakerName}: ${text}`);

    const alignment = isAgent ? "justify-end" : "justify-start";
    const textAlign = isAgent ? "text-right" : "text-left";
    const bubbleBg = isAgent ? "bg-blue-100" : "bg-gray-100";
    const bubbleBorder = isAgent ? "border-blue-200" : "border-gray-200";
    const textColor = isAgent ? "text-blue-900" : "text-gray-800";

    const msgDiv = document.createElement('div');
    msgDiv.className = `flex w-full group fade-in mb-3 ${alignment}`;
    msgDiv.innerHTML = `
        <div class="max-w-[85%] flex flex-col ${textAlign}">
            <span class="text-[10px] text-gray-400 font-medium mb-1 shrink-0">${speakerName} • ${time}</span>
            <div class="p-3 rounded-lg border shadow-sm ${bubbleBg} ${bubbleBorder}">
                <p class="text-sm leading-relaxed ${textColor} break-words">${escapeHtml(text)}</p>
            </div>
        </div>
    `;
    
    container.insertBefore(msgDiv, interimDiv);
    container.scrollTop = container.scrollHeight;
}

// ==========================================
// UTILIDADES
// ==========================================
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function showError(msg) {
    const errorAlert = document.getElementById('error-alert');
    const errorMessage = document.getElementById('error-message');
    errorMessage.textContent = msg;
    errorAlert.classList.remove('hidden');
    setTimeout(() => errorAlert.classList.add('hidden'), 5000);
}

function showSuccess(msg) {
    const successAlert = document.getElementById('success-alert');
    const successMessage = document.getElementById('success-message');
    successMessage.textContent = msg;
    successAlert.classList.remove('hidden');
    setTimeout(() => successAlert.classList.add('hidden'), 3000);
}

function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ==========================================
// GENERAR CONTENIDO EN MARKDOWN
// ==========================================
// Convierte las líneas guardadas (formato "[hora] Hablante: texto") en un
// documento .md legible, con encabezado, metadatos y una sección por turno.
function buildMarkdown(lines, fecha, hora) {
    let md = `# 📞 Transcripción Fonax\n\n`;
    md += `**Fecha:** ${fecha}  \n`;
    md += `**Hora:** ${hora}\n\n`;
    md += `---\n\n`;

    lines.forEach((linea) => {
        const match = linea.match(/^\[(.*?)\]\s*(.*?):\s*([\s\S]*)$/);
        if (match) {
            const [, time, speaker, text] = match;
            const icon = speaker.includes('Agente') ? '🎧' : '👤';
            md += `**${icon} ${speaker}** _(${time})_\n\n${text}\n\n`;
        } else {
            md += `${linea}\n\n`;
        }
    });

    return md.trim() + '\n';
}

// ==========================================
// EVENT LISTENERS
// ==========================================
btnToggle.addEventListener('click', () => isListening ? stopListening() : startListening());
document.getElementById('close-error')?.addEventListener('click', () => document.getElementById('error-alert').classList.add('hidden'));
document.getElementById('toggle-help')?.addEventListener('click', () => document.getElementById('help-panel').classList.toggle('hidden'));

document.getElementById('btn-clear')?.addEventListener('click', () => {
    if (finalTranscripts.length === 0) return;
    if (confirm('¿Borrar el texto actual en pantalla?')) {
        container.querySelectorAll('.group').forEach(m => m.remove());
        finalTranscripts = [];
        if (!isListening) emptyState.classList.remove('hidden');
    }
});

document.getElementById('btn-copy')?.addEventListener('click', () => {
    if (finalTranscripts.length === 0) return showError('No hay texto para copiar');
    const textoLimpio = finalTranscripts.map(linea => linea.replace(/^\[.*?\]\s*/, '')).join('\n');
    navigator.clipboard.writeText(textoLimpio).then(() => showSuccess('Copiado al portapapeles')).catch(() => showError('No se pudo copiar'));
});

document.getElementById('btn-download')?.addEventListener('click', () => {
    if (finalTranscripts.length === 0) return showError('No hay texto para descargar');
    const fecha = new Date().toLocaleDateString('es-CO');
    const hora = new Date().toLocaleTimeString('es-CO');
    const contenido = buildMarkdown(finalTranscripts, fecha, hora);
    downloadFile(contenido, `Fonax_${Date.now()}.md`, 'text/markdown');
});

document.getElementById('btn-save')?.addEventListener('click', () => {
    if (finalTranscripts.length === 0) return showError('No hay texto para guardar');
    chrome.storage.local.getBytesInUse(null, (bytes) => {
        if (bytes > 8000000) return showError('Historial casi lleno. Borra algunos registros.');
        const newRecord = {
            id: Date.now(),
            date: new Date().toLocaleDateString('es-CO'),
            time: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
            content: finalTranscripts.join('\n'),
            preview: finalTranscripts[0]?.substring(15, 50) + "..." || "Sin preview"
        };
        savedHistory.unshift(newRecord);
        chrome.storage.local.set({ 'fonax_history': savedHistory }, () => {
            showSuccess('Transcripción guardada');
            renderHistory();
        });
    });
});

document.getElementById('btn-show-history')?.addEventListener('click', () => {
    renderHistory();
    document.getElementById('history-modal').classList.remove('hidden');
});
document.getElementById('close-history')?.addEventListener('click', () => document.getElementById('history-modal').classList.add('hidden'));

function renderHistory() {
    historyList.innerHTML = '';
    if (savedHistory.length === 0) {
        historyList.innerHTML = '<p class="text-center text-gray-500 mt-5 text-sm">No hay llamadas guardadas.</p>';
        return;
    }
    savedHistory.forEach(record => {
        const item = document.createElement('div');
        item.className = 'bg-white border border-gray-200 rounded p-3 shadow-sm mb-3';
        item.innerHTML = `
            <div class="flex justify-between items-start mb-1">
                <div class="text-xs font-bold text-gray-800">${record.date} <span class="text-gray-500 font-normal ml-1">${record.time}</span></div>
                <button data-action="delete" data-id="${record.id}" class="text-gray-300 hover:text-red-500 transition-colors"><i class="fas fa-trash pointer-events-none"></i></button>
            </div>
            <p class="text-xs text-gray-600 mb-2 italic truncate">"${escapeHtml(record.preview)}"</p>
            <div class="flex gap-2">
                <button data-action="copy" data-id="${record.id}" class="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-[11px] py-1 rounded transition-colors"><i class="fas fa-copy pointer-events-none"></i> Copiar</button>
                <button data-action="download" data-id="${record.id}" class="flex-1 bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] py-1 rounded transition-colors"><i class="fas fa-download pointer-events-none"></i> Descargar</button>
            </div>
        `;
        historyList.appendChild(item);
    });
}

historyList?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const id = parseInt(btn.getAttribute('data-id'));
    const record = savedHistory.find(r => r.id === id);

    if (action === 'delete') {
        if (confirm('¿Eliminar esta transcripción?')) {
            savedHistory = savedHistory.filter(r => r.id !== id);
            chrome.storage.local.set({ 'fonax_history': savedHistory }, renderHistory);
            showSuccess('Eliminado');
        }
    } else if (action === 'copy' && record) {
        const textoLimpio = record.content.split('\n').map(linea => linea.replace(/^\[.*?\]\s*/, '')).join('\n');
        navigator.clipboard.writeText(textoLimpio).then(() => showSuccess('Copiado')).catch(() => showError('No se pudo copiar'));
    } else if (action === 'download' && record) {
        const lineas = record.content.split('\n');
        const contenido = buildMarkdown(lineas, record.date, record.time);
        downloadFile(contenido, `Fonax_${record.id}.md`, 'text/markdown');
    }
});

document.getElementById('btn-clear-history')?.addEventListener('click', () => {
    if (savedHistory.length > 0 && confirm('¿Borrar TODO el historial? Esta acción no se puede deshacer.')) {
        savedHistory = [];
        chrome.storage.local.remove('fonax_history', renderHistory);
        showSuccess('Historial limpiado');
    }
});