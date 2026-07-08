// ==========================================
// BACKGROUND SERVICE WORKER (MV3) - USO LOCAL
// ==========================================

// Tu API Key privada de Deepgram (Uso local)
const DEEPGRAM_API_KEY = '9601a6617bd52817d53ac55f5c40223d63653a0e'; 

// Abrir panel lateral automáticamente al hacer clic en el ícono de la extensión
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'transcriptor.html',
    enabled: true
  });
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ==========================================
// PROXY DE CONEXIÓN A DEEPGRAM
// ==========================================
// Centralizamos la configuración de la IA para enviar parámetros limpios al frontend
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getDeepgramToken') {
    
    // Parámetros de grado empresarial: Español, formato inteligente, multicanal y puntuación
    const wsUrl = 'wss://api.deepgram.com/v1/listen?language=es&model=nova-2&smart_format=true&multichannel=true&punctuate=true';

    sendResponse({
      token: DEEPGRAM_API_KEY,
      wsUrl: wsUrl
    });
  }
  return true; // Mantiene el canal de mensajes abierto para la respuesta asíncrona
});

// Manejo de eventos de instalación
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Transcriptor Fonax instalado correctamente (Versión Local).');
  }
});