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
    console.log("🚀 Iniciando sincronização first-time...");

    // Garante que o token esteja válido antes de iniciar o fluxo first-time
    const token = await getValidBlingToken(empresa_id, accessToken, refresh_token);

    // Passa os parâmetros individualmente para a função executeSteps
    return await executeSteps(empresa_id, token, refresh_token, paginaAtual);
}

/**
 * Fluxo diário para sincronização incremental.
 * Esse fluxo atualiza somente os dados recentes.
 */
async function handleDailySync({ empresa_id, accessToken, refresh_token }) {
    console.log("🔄 Iniciando sincronização diária...");
    // Garante que o token esteja válido antes de iniciar o fluxo diário
    const token = await getValidBlingToken(empresa_id, accessToken, refresh_token);
    return await executeDailySync(empresa_id, token, refresh_token);
}

/**
 * Fluxo para sincronização de estoque.
 * Esse fluxo é dedicado exclusivamente à atualização dos dados de inventário.
 */
async function handleInventorySync({ empresa_id, accessToken, refresh_token }) {
    console.log("📦 Iniciando sincronização de estoque...");
    const token = await getValidBlingToken(empresa_id, accessToken, refresh_token);
    return await executeInventorySync(empresa_id, token, refresh_token);
}

module.exports = {
    handleFirstTimeSync,
    handleDailySync,
    handleInventorySync,
};
