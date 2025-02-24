// src/utils/dateUtils.js

/**
 * Retorna o número da semana do mês para uma data fornecida.
 * Exemplo: 05/02 -> Semana 1 do Mês 2.
 *
 * @param {Date} date - Objeto Date da data desejada.
 * @returns {number} - Número da semana no mês.
 */
function getWeekOfMonth(date) {
    const day = date.getDate();
    const startDay = new Date(date.getFullYear(), date.getMonth(), 1).getDay();
    return Math.ceil((day + startDay) / 7);
  }
  
  /**
   * Converte uma data para o formato YYYY-MM-DD.
   *
   * @param {Date} date - Objeto Date da data desejada.
   * @returns {string} - Data formatada em formato ISO (YYYY-MM-DD).
   */
  function formatDate(date) {
    return date.toISOString().split("T")[0];
  }
  
  module.exports = {
    getWeekOfMonth,
    formatDate,
  };
  