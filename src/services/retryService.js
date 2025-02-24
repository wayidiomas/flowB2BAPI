// src/services/retryService.js

const { refreshBlingToken } = require("./blingTokenService");

/**
 * Função genérica para reexecutar uma função em caso de erro 4XX ou 5XX.
 * @param {Function} func - Função a ser executada.
 * @param {number} empresa_id - ID da empresa.
 * @param {string} accessToken - Token de acesso atual.
 * @param {string} refresh_token - Token de atualização.
 * @param {Array} args - Argumentos adicionais a serem passados para a função.
 */
async function executeWithRetry(func, empresa_id, accessToken, refresh_token, ...args) {
    try {
        return await func(accessToken, ...args);
    } catch (error) {
        if (error.response && error.response.status >= 400 && error.response.status < 600) {
            console.log(`🔁 Erro ${error.response.status} detectado. Tentando atualizar o token...`);

            try {
                const newToken = await refreshBlingToken(empresa_id, refresh_token);
                console.log(`✅ Token atualizado com sucesso. Reexecutando a função...`);
                return await func(newToken.access_token, ...args);
            } catch (tokenError) {
                console.error(`❌ Erro ao atualizar o token:`, tokenError.message || tokenError);
                throw tokenError;
            }
        } else {
            console.error(`❌ Erro inesperado durante a execução da função:`, error.message || error);
            throw error;
        }
    }
}

module.exports = {
    executeWithRetry,
};
