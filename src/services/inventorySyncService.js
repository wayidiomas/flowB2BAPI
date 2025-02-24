require("dotenv").config();
const { delay, callWithNextPage } = require("../utils/pagination");
const { getValidBlingToken } = require("./blingTokenService");
const { executeWithRetry } = require("./retryService"); // ✅ Importação adicionada
const supabase = require("./supabaseService");

// =========================
// Função Auxiliar
// =========================

async function syncEstoqueWithPagination(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Inventory] Sincronizando estoque...");

    let nextPage = 1;

    while (nextPage !== null) {
        await executeWithRetry(async (token) => {
            const response = await global.fetch(`${process.env.SUPABASE_URL}/functions/v1/sync_estoque`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    access_token: token,
                    empresa_id: Number(empresa_id), // ✅ Garantir que seja um número
                    page: nextPage,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Erro ao sincronizar estoque - Página ${nextPage}: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            console.log(`Estoque - Página ${nextPage} sincronizada.`);

            nextPage = data.next_page ?? null;
            await delay(5000); // ✅ Delay de 5 segundos após cada requisição
        }, access_token, refresh_token);
    }

    console.log("✅ [Inventory] Sincronização de estoque concluída.");
}

// =========================
// Fluxo Principal
// =========================

async function executeInventorySync(empresa_id, access_token, refresh_token) {
    console.log(`\n🚀 [Inventory] Iniciando sincronização de estoque para empresa ${empresa_id}`);

    // ✅ Correção: Ordem correta dos parâmetros
    access_token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);

    await syncEstoqueWithPagination(empresa_id, access_token, refresh_token);

    console.log("✅ [Inventory] Sincronização de estoque concluída com sucesso!");
    return { success: true, message: "Inventory sync completed" };
}

module.exports = {
    executeInventorySync,
};
