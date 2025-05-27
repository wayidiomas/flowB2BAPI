// src/utils/edgeFunctionRetry.js
const delay = require("./delay");

/**
 * Função utilitária para chamar edge functions com retry
 * @param {Function} edgeFunctionCall - Função que chama a edge function
 * @param {number} maxRetries - Número máximo de tentativas (padrão: 20)
 * @param {number} initialDelay - Delay inicial entre tentativas em ms (padrão: 1000)
 * @param {number} backoffFactor - Fator de aumento do delay entre tentativas (padrão: 1.5)
 */
async function callEdgeFunctionWithRetry(edgeFunctionCall, maxRetries = 20, initialDelay = 1000, backoffFactor = 1.5) {
  let currentDelay = initialDelay;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      const result = await edgeFunctionCall();
      return result; // Retorna o resultado se for bem-sucedido
    } catch (error) {
      retryCount++;
      
      // Verifica se é um erro 500 de timeout
      const isTimeoutError = 
        (error?.status === 500 || (error?.response?.status === 500)) && 
        ((error?.message?.includes('cancelling statement due to statement timeout') || 
         error?.message?.includes('timeout')) ||
         (error?.response?.data?.message?.includes('timeout') || 
          error?.response?.statusText?.includes('timeout')));
      
      // Se for o último retry ou não for um erro de timeout, propaga o erro
      if (retryCount >= maxRetries || !isTimeoutError) {
        console.error(`Falha após ${retryCount} tentativas:`, error);
        throw error;
      }
      
      // Log da falha e preparação para retry
      console.log(`Tentativa ${retryCount} falhou com timeout. Tentando novamente em ${currentDelay}ms...`);
      
      // Espera pelo delay atual antes de tentar novamente
      await delay(currentDelay);
      
      // Aumenta o delay para a próxima tentativa (exponential backoff)
      currentDelay = currentDelay * backoffFactor;
    }
  }
}

module.exports = {
  callEdgeFunctionWithRetry
};