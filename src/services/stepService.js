// src/services/stepService.js

const supabase = require("./supabaseService");
const dateUtils = require('../utils/dateUtils');
const { callWithNextPage, delay } = require("../utils/pagination");
const { getValidBlingToken } = require("./blingTokenService");
const { executeWithRetry } = require("./retryService");

const TIME_80s = 80_000;

// =========================
// Funções Auxiliares de Paginação
// =========================

async function syncWithPagination(url, body, empresa_id, refresh_token, useQuantity = false) {
    let nextPage = 1;
    let quantidade = 100;
    let isPaginationFinished = false; // Flag para encerrar o loop

    while (!isPaginationFinished) {
        body.page = nextPage;

        await executeWithRetry(async (token) => {
            body.access_token = token; // Atualiza o token antes da chamada
            const result = await callWithNextPage(url, body, {}, 50000, useQuantity); // ✅ Delay de 50s diretamente no callWithNextPage

            if (useQuantity) {
                quantidade = result?.quantidade ?? 0;
                if (quantidade < 100) isPaginationFinished = true; // Finaliza quando a quantidade for menor que 100
                else nextPage++;
            } else {
                nextPage = result?.next_page ?? null;
                if (nextPage === null) isPaginationFinished = true; // Finaliza quando não há mais páginas
            }
        }, empresa_id, body.access_token, refresh_token);
    }
}


async function etapaProdutos(empresa_id, accessToken, refresh_token) {
   console.log("🚀 [Etapa 1] Iniciando sincronização de Produtos e Detalhes");

    // Step 1: Sincronizar produtos usando quantidade (< 100 para encerrar)
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_prod_2`,
            { empresa_id, access_token: token },
            empresa_id, refresh_token, true // ✅ Controla paginação usando 'quantidade'
        );
    }, empresa_id, accessToken, refresh_token);

    // Step 2: Sincronizar detalhes do produto usando next_page
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_detalhes_prod`,
            { empresa_id, access_token: token },
            empresa_id, refresh_token, false // ✅ Controla paginação usando 'next_page'
        );
    }, empresa_id, accessToken, refresh_token);

    console.log("✅ [Etapa 1] Produtos e Detalhes concluídos.");

}

// =========================
// Etapa 2: Fornecedores e Detalhes
// =========================

async function etapaFornecedores(empresa_id, accessToken, refresh_token) {
    
    console.log("🚀 [Etapa 2] Iniciando sincronização de Fornecedores e Detalhes");
    
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sync_fornecedor_by_productID`,
            { empresa_id, access_token: token },
            empresa_id, refresh_token
        );
    }, empresa_id, accessToken, refresh_token);
    
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_fornecedor`,
            { empresa_id, access_token: token },
            empresa_id, refresh_token
        );
    }, empresa_id, accessToken, refresh_token);

    console.log("✅ [Etapa 2] Fornecedores e Detalhes concluídos.");
    
}

// =========================
// Etapa 3: Pedidos de Venda e Detalhes
// =========================

async function etapaPedidosVenda(empresa_id, accessToken, refresh_token) {
    console.log("🚀 [Etapa 3] Iniciando sincronização de Pedidos de Venda e Detalhes");

    const currentDate = new Date();
    const oneYearAgo = new Date(currentDate);
    oneYearAgo.setFullYear(currentDate.getFullYear() - 1);

    let iterationDate = new Date(currentDate);

    // 🔹 Loop de sincronização diaria de pedidos de venda
    
    await executeWithRetry(async (token) => {
        while (iterationDate >= oneYearAgo) {
            const data_dia = iterationDate.toISOString().split('T')[0]; // Formata a data como "YYYY-MM-DD"
    
            console.log(`[Loop Pedido Venda] 🗓️ Sincronizando pedidos para o dia: ${data_dia}`);
    
            const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/sync_pedido_venda`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    empresa_id,
                    access_token: token,
                    data_dia // Envia o parâmetro data_dia
                }),
            });
    
            const result = await response.json();
            console.log(`[Loop Pedido Venda] ✅ Resposta da sincronização para o dia ${data_dia}:`, result);
    
            iterationDate.setDate(iterationDate.getDate() - 1); // Retrocede um dia
            console.log(`[Loop Pedido Venda] ⏸️ Aguardando 5 segundos antes da próxima iteração...`);
            await delay(5000); // ✅ Delay de 5 segundos após cada requisição
        }
    }, empresa_id, accessToken, refresh_token);
    
   

    // 🔹 Loop de sincronização semanal de detalhes dos pedidos de venda
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_venda`,
            { empresa_id, access_token: token },
            empresa_id, 
            refresh_token
        );
    }, empresa_id, accessToken, refresh_token);
    
            console.log(`[Loop Detalhe Pedido Venda] ⏸️ Aguardando 5 segundos antes da próxima iteração...`);
            await delay(5000); // ✅ Delay de 5 segundos após cada requisição
        }
    
    
    console.log("✅ [Etapa 3] Pedidos de Venda e Detalhes concluídos.");
    




// =========================
// Etapa 4: Pedidos de Compra e Detalhes
// =========================

async function etapaPedidosCompra(empresa_id, accessToken, refresh_token) {
    console.log("🚀 [Etapa 4] Iniciando sincronização de Pedidos de Compra e Detalhes");

    const { data: fornecedoresList, error } = await supabase
        .from("fornecedores")
        .select("id_bling")
        .eq("empresa_id", Number(empresa_id))
        .not("id_bling", "is", null);

    if (error) throw error;

    console.log(`🔎 [Fornecedores] Total de fornecedores encontrados: ${fornecedoresList.length}`);

    // 🔹 Loop para sincronizar pedidos de compra por fornecedor
    for (const [index, forn] of fornecedoresList.entries()) {

        if (forn.id_bling === 0) {console.warn(`⚠️ [Fornecedor ${index + 1}/${fornecedoresList.length}] Ignorado - ID inválido: ${forn.id_bling}`);
        continue;} // Pule este fornecedor


        console.log(`🔁 [Fornecedor ${index + 1}/${fornecedoresList.length}] Iniciando sincronização - ID: ${forn.id_bling}`);

        await executeWithRetry(async (token) => {
            const url = `${process.env.SUPABASE_URL}/functions/v1/sync_pedido_compra`;
            const body = {
                empresa_id,
                access_token: token,
                id_bling_fornecedor: forn.id_bling
            };

            console.log(`📤 [Request] URL: ${url}, Body:`, body);

            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });

                console.log(`📥 [Response] Status: ${response.status}`);

                if (!response.ok) {
                    const responseText = await response.text();
                    throw new Error(`Erro HTTP (${response.status}): ${responseText}`);
                }

                console.log(`✅ [Fornecedor ${forn.id_bling}] Sincronização concluída.`);
            } catch (error) {
                console.error(`❌ [Fornecedor ${forn.id_bling}] Erro durante a sincronização:`, error.message);
                throw error;
            }

            console.log(`⏸️ Aguardando 5 segundos antes do próximo fornecedor...`);
            await delay(5000); // ✅ Delay de 5 segundos imediatamente após a requisição
        }, empresa_id, accessToken, refresh_token);

        console.log(`🔁 [Fornecedor ${index + 1}/${fornecedoresList.length}] Finalizado.`);
    }

    console.log("✅ [Fornecedores] Loop de sincronização concluído.");

    // 🔹 Sincronização de detalhes dos pedidos de compra
    console.log("🚀 [detalhes_pedido_compra] Iniciando sincronização...");
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/detalhes_pedido_compra`,
            { empresa_id, access_token: token },
            empresa_id, refresh_token
        );
        console.log("✅ [detalhes_pedido_compra] Sincronização concluída.");
        console.log("⏸️ Aguardando 10 segundos antes da próxima etapa...");
        await delay(1000);
    }, empresa_id, accessToken, refresh_token);

    // 🔹 Sincronização das últimas compras
    console.log("🚀 [sincronizar_ultimas_compras] Iniciando sincronização...");
    await executeWithRetry(async (token) => {
        await syncWithPagination(
            `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`,
            { empresa_id, access_token: token },
            empresa_id, refresh_token
        );
        console.log("✅ [sincronizar_ultimas_compras] Sincronização concluída.");
        console.log("⏸️ Aguardando 5 segundos antes da próxima etapa...");
        await delay(5000);
    }, empresa_id, accessToken, refresh_token);

    console.log("✅ [Etapa 4] Pedidos de Compra e Detalhes concluídos.");
}


// =========================
// Etapa 5: Fluxo de Notas Fiscais
// =========================

async function etapaNotasFiscais(empresa_id, accessToken, refresh_token) {
    console.log("🚀 [Etapa 5] Iniciando sincronização do Fluxo de Notas Fiscais");

    const currentDate = new Date();
    const oneYearAgo = new Date(currentDate);
    oneYearAgo.setFullYear(currentDate.getFullYear() - 1);

    let iterationDate = new Date(currentDate);

     // 🔹 Loop de sincronização mensal de últimas compras
     await executeWithRetry(async (token) => {
        console.log("🔁 [Últimas Compras] Iniciando loop mensal...");
        while (iterationDate >= oneYearAgo) {
            const startDate = new Date(iterationDate);
            startDate.setDate(1); // Início do mês
            const endDate = new Date(iterationDate);
            endDate.setDate(new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).getDate()); // Fim do mês

            const payload = {
                empresa_id,
                access_token: token,
                start_date: dateUtils.formatDate(startDate),
                end_date: dateUtils.formatDate(endDate),
            };

            const url = `${process.env.SUPABASE_URL}/functions/v1/sincronizar_ultimas_compras`;
            console.log(`📤 [Request] URL: ${url}, Payload:`, payload);

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            console.log(`📥 [Response] Status: ${response.status}`);
            if (!response.ok) {
                console.error(`❌ [Erro] ao sincronizar últimas compras. Status: ${response.status}`);
            } else {
                const data = await response.json();
                console.log(`✅ [Sucesso] Resposta da sincronização:`, JSON.stringify(data, null, 2));
            }

            await delay(20000); // Delay de 20 segundos após cada requisição
            iterationDate.setMonth(iterationDate.getMonth() - 1); // Retrocede um mês
        }
    }, empresa_id, accessToken, refresh_token);

    console.log("✅ [Loop Mensal Concluído] Sincronização de últimas compras finalizada.");

    // 🔹 Sincronização de detalhes das notas fiscais
    await executeWithRetry(async (token) => {
        console.log("📦 [Detalhes das Notas Fiscais] Iniciando sincronização...");

        const payload = { empresa_id, access_token: token };
        const url = `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal`;

        console.log(`📤 [Request] URL: ${url}, Payload:`, payload);

        await syncWithPagination(url, payload, empresa_id, refresh_token);

        console.log(`✅ [Sucesso] Detalhes das notas fiscais sincronizados.`);
        await delay(50000);
    }, empresa_id, accessToken, refresh_token);

    // 🔹 Loop de sincronização de notas fiscais por chave de acesso
    console.log("🔁 [Notas Fiscais por Chave de Acesso] Buscando chaves no Supabase...");

    const { data: chavesList, error } = await supabase
        .from("notas_fiscais")
        .select("chave_acesso")
        .eq("empresa_id", Number(empresa_id))
        .not("chave_acesso", "is", null);

    if (error) throw error;

    console.log(`📦 [Notas Fiscais] Total de chaves encontradas: ${chavesList.length}`);

    const url = `${process.env.SUPABASE_URL}/functions/v1/detalhes_nota_fiscal_chave_acesso`;

    for (const [index, nota] of chavesList.entries()) {
        try {
            const payload = {
            chave_acesso: nota.chave_acesso,
            empresa_id: Number(empresa_id),
    };

         console.log(`📤 [Request ${index + 1}/${chavesList.length}] URL: ${url}, Payload:`, payload);

            const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        console.log(`📥 [Response] Status: ${response.status}`);
            if (!response.ok) {
            console.error(`❌ [Erro] ao sincronizar nota fiscal (chave: ${nota.chave_acesso}). Status: ${response.status}`);
        }   else {
                const data = await response.json();
            console.log(`✅ [Sucesso] Nota fiscal sincronizada (chave: ${nota.chave_acesso}):`, JSON.stringify(data, null, 2));
        }

        await delay(500);
    }   catch (err) {
        console.error(`❌ [Erro] Falha ao processar nota fiscal (chave: ${nota.chave_acesso}):`, err);
    }
}


    // 🔁 [Detalhamento de Produtos] Sincronização
    console.log("🔁 [Detalhamento de Produtos] Iniciando sincronização...");

    try {
        const payload = {
            empresa_id: Number(empresa_id),
            webhook_url: process.env.WEBHOOK_URL,
            data_inicio: dateUtils.formatDate(oneYearAgo),
            data_fim: dateUtils.formatDate(currentDate),
    };

        const url = `${process.env.VALIDACAO_EAN_URL}/detalhamento_de_produtos/`;
        console.log(`📤 [Request] URL: ${url}, Payload:`, payload);

        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
    });

        console.log(`📥 [Response] Status: ${response.status}`);
        if (!response.ok) {
            console.error(`❌ [Erro] ao sincronizar detalhamento de produtos. Status: ${response.status}`);
        } else {
        const data = await response.json();
        console.log(`✅ [Sucesso] Detalhamento de produtos sincronizado:`, JSON.stringify(data, null, 2));
    }
}    catch (error) {
        console.error(`❌ [Erro] Erro ao executar sincronização de detalhamento de produtos:`, error);
}

// 🔁 [Vínculo de Produtos por Fornecedor] Sincronização
    console.log("🔁 [Vínculo de Produtos por Fornecedor] Iniciando sincronização...");

    try {
        const payload = {
            empresa_id: Number(empresa_id),
            webhook_url: process.env.WEBHOOK_URL_VINCULO,
    };

        const url = `${process.env.VALIDACAO_EAN_URL}/vinculo_produto_por_fornecedor/`;
        console.log(`📤 [Request] URL: ${url}, Payload:`, payload);

        const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

        console.log(`📥 [Response] Status: ${response.status}`);
        if (!response.ok) {
        console.error(`❌ [Erro] ao sincronizar vínculo de produtos. Status: ${response.status}`);
    }   else {
            const data = await response.json();
            console.log(`✅ [Sucesso] Vínculo de produtos sincronizado:`, JSON.stringify(data, null, 2));
    }
}   catch (error) {
        console.error(`❌ [Erro] Erro ao executar sincronização de vínculo de produtos:`, error);
}
 // 🔹 Sincronização de estoque
        await executeWithRetry(async (token) => {
        console.log("📦 [Estoque] Iniciando sincronização...");

        const payload = { empresa_id, access_token: token };
        const url = `${process.env.SUPABASE_URL}/functions/v1/sync_estoque`;

        console.log(`📤 [Request] URL: ${url}, Payload:`, payload);

        await syncWithPagination(url, payload, empresa_id, refresh_token);

        console.log(`✅ [Sucesso] Sincronização de estoque concluída.`);
        await delay(5000);
    }, empresa_id, accessToken, refresh_token);

    // 🔹 Sincronização de formas de pagamento dos pedidos de compra
    await executeWithRetry(async (token) => {
        console.log("💳 [Formas de Pagamento] Iniciando sincronização...");

        const payload = { empresa_id, access_token: token };
        const url = `${process.env.SUPABASE_URL}/functions/v1/sync_formas_de_pagamento_pedidos_de_compra`;

        console.log(`📤 [Request] URL: ${url}, Payload:`, payload);

        await syncWithPagination(url, payload, empresa_id, refresh_token);

        console.log(`✅ [Sucesso] Sincronização de formas de pagamento concluída.`);
        await delay(5000);
    }, empresa_id, accessToken, refresh_token);

    console.log("✅ [Etapa 5] Fluxo de Notas Fiscais concluído.");
}


// =========================
// Função Principal
// =========================

async function executeSteps(empresa_id, accessToken, refresh_token, paginaAtual = 1) {
    try {
        
        console.log(`🚀 Iniciando sincronização em etapas para empresa ${empresa_id}, página inicial: ${paginaAtual}`);
        const token = await getValidBlingToken(empresa_id, accessToken, refresh_token);
        
        await etapaProdutos(empresa_id, token, refresh_token, paginaAtual);
        await delay(TIME_80s);
        
        await etapaFornecedores(empresa_id, token, refresh_token);
        await delay(TIME_80s);
        

        
        await etapaPedidosVenda(empresa_id, token, refresh_token);
        await delay(TIME_80s);
        
        
        await etapaPedidosCompra(empresa_id, token, refresh_token);
        await delay(TIME_80s);
        
        await etapaNotasFiscais(empresa_id, token, refresh_token);

        console.log("✅ Sincronização concluída com sucesso!");
    } catch (error) {
        console.error("❌ Erro durante a sincronização:", error);
        throw error;
    }
}

module.exports = {
    executeSteps,
};
