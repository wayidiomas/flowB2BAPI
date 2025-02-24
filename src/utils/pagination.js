const delay = require("../utils/delay");

/**
 * callWithNextPage:
 * - Realiza requisições POST encadeadas enquanto:
 *   - Step 1: `quantidade >= 100`.
 *   - Demais Steps: `next_page !== null`.
 * - Aguarda `delayMs` entre cada requisição para respeitar o rate limit.
 *
 * @param {string} url - URL do endpoint a ser chamado.
 * @param {object} body - Corpo da requisição, incluindo os parâmetros necessários.
 * @param {object} headers - Cabeçalhos da requisição (default: `{}`).
 * @param {number} delayMs - Tempo em milissegundos para aguardar entre as requisições (default: 50000ms).
 * @param {boolean} useQuantity - Define se deve usar `quantidade` para finalizar (apenas no Step 1).
 * @returns {Promise<object>} - O resultado final da última requisição.
 */
async function callWithNextPage(url, body, headers = {}, delayMs = 10000, useQuantity = false) {
    let pagina = body.page || 1;
    let finalData = null;

    while (true) {
        console.log(`\n[callWithNextPage] Chamando ${url} - página=${pagina}`);
        const payload = { ...body, page: pagina };

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...headers,
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Erro HTTP (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            console.log(`[callWithNextPage] Resposta da página=${pagina}:`, data);

            finalData = data;

            // Lógica de paginação:
            if (useQuantity) {
                // Step 1: Continua enquanto quantidade >= 100
                const quantidade = data.quantidade ?? 0;
                if (quantidade < 100) {
                    console.log("[callWithNextPage] Fim da paginação (quantidade < 100).");
                    break;
                }
                pagina++;
            } else {
                // Demais Steps: Continua enquanto next_page !== null
                const nextPage = data.next_page ?? null;
                if (!nextPage) {
                    console.log("[callWithNextPage] Fim da paginação (next_page = null).");
                    break;
                }
                pagina = nextPage;
            }

            console.log(`⏸️ Pausando ${delayMs / 1000} segundos antes da próxima página...`);
            await delay(delayMs); // ✅ Delay de 10  segundos (ou conforme passado no parâmetro delayMs)
        } catch (error) {
            console.error(`[callWithNextPage] ❌ Erro durante a chamada da página ${pagina}:`, error.message || error);
            throw error;
        }
    }

    return finalData;
}

module.exports = {
    callWithNextPage,
    delay
};
