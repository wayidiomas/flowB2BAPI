// src/services/inventorySyncService.js
require("dotenv").config();
const { delay } = require("../utils/pagination");
const { getValidBlingToken } = require("./blingTokenService");
const { callEdgeFunction } = require("./edgeFunctionService"); // Nova importação

const TIME_5s = 10000; // ✅ Delay configurável

// =========================
// Função Auxiliar
// =========================

async function syncEstoqueWithPagination(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Inventory] Sincronizando estoque...");

    let nextPage = 1; // ✅ Inicia automaticamente com a página 1
    let isPaginationFinished = false; // ✅ Flag para encerrar o loop

    while (!isPaginationFinished) {
        try {
            console.log(`➡️ [Inventory] Iniciando requisição - Página ${nextPage}`);
            
            // Uso do novo serviço de Edge Function com retry
            const data = await callEdgeFunction(
                `${process.env.SUPABASE_URL}/functions/v1/sync_estoque`,
                { page: nextPage || 1 },
                empresa_id,
                access_token,
                refresh_token,
                { 
                    maxRetries: 20,
                    initialDelay: 2000,
                    backoffFactor: 1.5,
                    headers: { "Content-Type": "application/json" }
                }
            );
            
            console.log(`✅ [Inventory] Estoque - Página ${nextPage} sincronizada.`);
            
            nextPage = data.next_page ?? null;
            isPaginationFinished = nextPage === null;
            
            console.log(`⏸️ [Inventory] Delay de ${TIME_5s / 1000}s antes da próxima página...`);
            await delay(TIME_5s);
        } catch (error) {
            console.error(`❌ [Inventory] Erro fatal na sincronização de estoque - Página ${nextPage}:`, error);
            throw error; // Propaga o erro após todas as tentativas de retry falharem
        }
    }

    console.log("✅ [Inventory] Sincronização de estoque concluída.");
}

// =========================
// Fluxo Principal
// =========================

async function executeInventorySync(empresa_id, access_token, refresh_token) {
    console.log(`\n🚀 [Inventory] Iniciando sincronização de estoque para empresa ${empresa_id}`);

    try {
        // ✅ Obtém o token apenas uma vez antes do loop
        const token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);
        console.log(`🔑 [Inventory] Token obtido: ${token}`);

        // ✅ Chama a função de sincronização passando o `accessToken` inicial
        await syncEstoqueWithPagination(empresa_id, token, refresh_token);

        console.log("✅ [Inventory] Sincronização de estoque concluída com sucesso!");
        return { success: true, message: "Inventory sync completed" };
    } catch (error) {
        console.error(`❌ [Inventory] Erro na execução da sincronização de estoque:`, error);
        return { 
            success: false, 
            message: "Inventory sync failed", 
            error: error.message 
        };
    }
}

module.exports = {
    executeInventorySync,
};