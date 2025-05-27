// src/services/edgeFunctionService.js
const { callEdgeFunctionWithRetry } = require("../utils/edgeFunctionRetry");
const { getValidBlingToken } = require("./blingTokenService");

/**
 * Chama uma Edge Function do Supabase com mecanismo de retry
 * @param {string} url - URL da Edge Function
 * @param {Object} payload - Payload da requisição
 * @param {number} empresa_id - ID da empresa
 * @param {string} accessToken - Token de acesso atual
 * @param {string} refresh_token - Token de atualização
 * @param {Object} options - Opções adicionais (headers, maxRetries, etc.)
 * @returns {Promise<any>} - Resultado da Edge Function
 */
async function callEdgeFunction(url, payload, empresa_id, accessToken, refresh_token, options = {}) {
  const {
    headers = { "Content-Type": "application/json" },
    maxRetries = 20,
    initialDelay = 1000,
    backoffFactor = 1.5
  } = options;

  // Assegura que temos um token válido
  const token = await getValidBlingToken(empresa_id, accessToken, refresh_token);
  
  // Monta o payload com o token atualizado
  const finalPayload = {
    ...payload,
    access_token: token,
    empresa_id: Number(empresa_id)
  };

  // Define a função que será chamada com retry
  const edgeFunctionCall = async () => {
    console.log(`📤 [EdgeFunction] Chamando ${url} com payload:`, finalPayload);
    
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(finalPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`Erro HTTP (${response.status}): ${errorText}`);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  };

  // Executa a chamada com retry
  return await callEdgeFunctionWithRetry(
    edgeFunctionCall,
    maxRetries,
    initialDelay,
    backoffFactor
  );
}

module.exports = {
  callEdgeFunction
};