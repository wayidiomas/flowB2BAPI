require("dotenv").config();
const { delay } = require("../utils/pagination");
const { getValidBlingToken } = require("./blingTokenService");
const { executeWithRetry } = require("./retryService");

const TIME_5s = 10000; // ✅ Delay configurável

// =========================
// Função Auxiliar
// =========================

async function syncEstoqueWithPagination(empresa_id, access_token, refresh_token) {
    console.log("🔄 [Inventory] Sincronizando estoque...");

    let nextPage = 1; // ✅ Inicia automaticamente com a página 1
    let isPaginationFinished = false; // ✅ Flag para encerrar o loop

    while (!isPaginationFinished) {
        await executeWithRetry(async (token) => {
            console.log(`➡️ [Inventory] Iniciando requisição - Página ${nextPage}`);
            console.log(`🔑 [Inventory] Token usado: ${token}`);

            const payload = {
                access_token: token,
                empresa_id: Number(empresa_id),
                page: nextPage || 1,
            };

            console.log(`📤 [Inventory] Payload enviado:`, payload);

            const response = await global.fetch(`${process.env.SUPABASE_URL}/functions/v1/sync_estoque`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error(`🔥 [Inventory] Erro ao sincronizar estoque - Página ${nextPage}: ${response.status} - ${errorText}`);
                throw new Error(`Erro ao sincronizar estoque - Página ${nextPage}: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            console.log(`✅ [Inventory] Estoque - Página ${nextPage} sincronizada.`);

            nextPage = data.next_page ?? null;
            isPaginationFinished = nextPage === null;

            console.log(`⏸️ [Inventory] Delay de ${TIME_5s / 1000}s antes da próxima página...`);
            await delay(TIME_5s);
        }, empresa_id, access_token, refresh_token); // ✅ Agora passa o `accessToken` inicial corretamente
    }

    console.log("✅ [Inventory] Sincronização de estoque concluída.");
}

// =========================
// Fluxo Principal
// =========================

async function executeInventorySync(empresa_id, access_token, refresh_token) {
    console.log(`\n🚀 [Inventory] Iniciando sincronização de estoque para empresa ${empresa_id}`);

    // ✅ Obtém o token apenas uma vez antes do loop
    const token = await getValidBlingToken(Number(empresa_id), access_token, refresh_token);
    console.log(`🔑 [Inventory] Token obtido: ${token}`);

    // ✅ Chama a função de sincronização passando o `accessToken` inicial
    await syncEstoqueWithPagination(empresa_id, token, refresh_token);

    console.log("✅ [Inventory] Sincronização de estoque concluída com sucesso!");
    return { success: true, message: "Inventory sync completed" };
}

module.exports = {
    executeInventorySync,
};
