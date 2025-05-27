// src/services/syncService.js
require("dotenv").config();
const { getValidBlingToken } = require("./blingTokenService");
const { executeSteps } = require("./stepService"); // Fluxo completo (first-time)
const { executeDailySync } = require("./dailySyncService"); // Fluxo diário
const { executeInventorySync } = require("./inventorySyncService"); // Fluxo de estoque

/**
 * Fluxo completo para sincronização first-time.
 * Executa todos os steps definidos no stepService.js.
 */
async function handleFirstTimeSync({ empresa_id, accessToken, refresh_token, paginaAtual = 1 }) {
    console.log(`🚀 [Sync] Iniciando sincronização first-time para empresa ${empresa_id}...`);

    try {
        // Garante que o token esteja válido antes de iniciar o fluxo first-time
        const token = await getValidBlingToken(Number(empresa_id), accessToken, refresh_token);
        console.log(`🔑 [Sync] Token válido obtido: ${token.substring(0, 10)}...`);

        // Passa os parâmetros individualmente para a função executeSteps
        const result = await executeSteps(empresa_id, token, refresh_token, paginaAtual);
        console.log(`✅ [Sync] Sincronização first-time concluída com ${result.success ? 'sucesso' : 'erros'}.`);
        return result;
    } catch (error) {
        console.error(`❌ [Sync] Erro na sincronização first-time:`, error);
        return { 
            success: false, 
            message: "Erro durante a sincronização first-time", 
            error: error.message || "Erro desconhecido"
        };
    }
}

/**
 * Fluxo diário para sincronização incremental.
 * Esse fluxo atualiza somente os dados recentes.
 */
async function handleDailySync({ empresa_id, accessToken, refresh_token }) {
    console.log(`🔄 [Sync] Iniciando sincronização diária para empresa ${empresa_id}...`);

    try {
        // Garante que o token esteja válido antes de iniciar o fluxo diário
        const token = await getValidBlingToken(Number(empresa_id), accessToken, refresh_token);
        console.log(`🔑 [Sync] Token válido obtido: ${token.substring(0, 10)}...`);

        const result = await executeDailySync(empresa_id, token, refresh_token);
        console.log(`✅ [Sync] Sincronização diária concluída com ${result.success ? 'sucesso' : 'erros'}.`);
        return result;
    } catch (error) {
        console.error(`❌ [Sync] Erro na sincronização diária:`, error);
        return { 
            success: false, 
            message: "Erro durante a sincronização diária", 
            error: error.message || "Erro desconhecido"
        };
    }
}

/**
 * Fluxo para sincronização de estoque.
 * Esse fluxo é dedicado exclusivamente à atualização dos dados de inventário.
 */
async function handleInventorySync({ empresa_id, accessToken, refresh_token }) {
    console.log(`📦 [Sync] Iniciando sincronização de estoque para empresa ${empresa_id}...`);

    try {
        // Garante que o token esteja válido antes de iniciar o fluxo de estoque
        const token = await getValidBlingToken(Number(empresa_id), accessToken, refresh_token);
        console.log(`🔑 [Sync] Token válido obtido: ${token.substring(0, 10)}...`);

        const result = await executeInventorySync(empresa_id, token, refresh_token);
        console.log(`✅ [Sync] Sincronização de estoque concluída com ${result.success ? 'sucesso' : 'erros'}.`);
        return result;
    } catch (error) {
        console.error(`❌ [Sync] Erro na sincronização de estoque:`, error);
        return { 
            success: false, 
            message: "Erro durante a sincronização de estoque", 
            error: error.message || "Erro desconhecido"
        };
    }
}

module.exports = {
    handleFirstTimeSync,
    handleDailySync,
    handleInventorySync,
};