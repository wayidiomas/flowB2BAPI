// src/utils/delay.js

/**
 * Função de atraso assíncrono.
 * Aguarda N milissegundos antes de resolver a Promise.
 * @param {number} ms - Tempo em milissegundos.
 * @returns {Promise<void>}
 */
async function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  module.exports = delay;
  