// src/services/blingHandlers.js
//
// Handlers reais que processam jobs da `bling_sync_queue` chamando a API
// do Bling v3. Cada handler usa `withBlingRateLimit` (300 req/min global)
// e `getValidBlingToken` (refresh automático). Em caso de falha:
//  - axios joga error com `response.status` que o worker usa pra decidir
//    retry (401/429/5xx) ou terminal (4xx).
//  - audit_log é gravado pelo worker, não aqui.

const axios = require("axios");
const supabase = require("./supabaseService");
const { logger } = require("../utils/logger");
const { getValidBlingToken } = require("./blingTokenService");
const { withBlingRateLimit } = require("../utils/rateLimiter");

const BLING_API = "https://api.bling.com.br/Api/v3";
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Faz chamada HTTP no Bling com rate limit + propagação correta de erros.
 * Em erro HTTP, joga um Error com `.status` e `.response` setados pra
 * que o worker (`extractErrorCode`) classifique corretamente.
 */
async function blingFetch(method, path, accessToken, body) {
    return withBlingRateLimit(async () => {
        try {
            const res = await axios({
                method,
                url: `${BLING_API}${path}`,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                data: body,
                timeout: REQUEST_TIMEOUT_MS,
                validateStatus: (s) => s >= 200 && s < 300
            });
            return res.data;
        } catch (err) {
            const status = err.response?.status;
            const respData = err.response?.data;
            const summary = typeof respData === 'object'
                ? JSON.stringify(respData).slice(0, 400)
                : String(respData || err.message).slice(0, 400);
            const error = new Error(`Bling ${method} ${path} → ${status || 'sem resposta'}: ${summary}`);
            error.status = status;
            error.response = err.response;
            throw error;
        }
    });
}

// ─── Handler: upsert_fornecedor_produto ──────────────────────────────────────
//
// Atualiza preço de um vínculo produto×fornecedor no Bling. Se o vínculo
// não existe, cria.
//
// Payload esperado:
//   { produto_id, produto_bling_id, fornecedor_bling_id, valor_de_compra }
async function handleUpsertFornecedorProduto(job /*, ctx */) {
    const { produto_bling_id, fornecedor_bling_id, valor_de_compra } = job.payload || {};

    if (!produto_bling_id) throw new Error('payload.produto_bling_id ausente');
    if (!fornecedor_bling_id) throw new Error('payload.fornecedor_bling_id ausente');
    if (!Number.isFinite(Number(valor_de_compra)) || Number(valor_de_compra) <= 0) {
        throw new Error(`payload.valor_de_compra inválido: ${valor_de_compra}`);
    }

    const accessToken = await getValidBlingToken(job.empresa_id);

    // Lista vínculos existentes pra esse par
    const list = await blingFetch(
        'GET',
        `/produtos/fornecedores?idProduto=${encodeURIComponent(produto_bling_id)}&idFornecedor=${encodeURIComponent(fornecedor_bling_id)}`,
        accessToken,
        null
    );

    const vinculos = Array.isArray(list?.data) ? list.data : [];

    if (vinculos.length > 0) {
        const vinculoId = vinculos[0].id;
        await blingFetch(
            'PUT',
            `/produtos/fornecedores/${vinculoId}`,
            accessToken,
            { precoCompra: Number(valor_de_compra) }
        );
        logger.info('upsert_fornecedor_produto: PUT preço OK', {
            service: 'bling-handler',
            empresa_id: job.empresa_id,
            jobId: job.id,
            produto_bling_id,
            fornecedor_bling_id,
            vinculoId,
            valor_de_compra
        });
    } else {
        await blingFetch(
            'POST',
            '/produtos/fornecedores',
            accessToken,
            {
                produto: { id: Number(produto_bling_id) },
                fornecedor: { id: Number(fornecedor_bling_id) },
                precoCompra: Number(valor_de_compra)
            }
        );
        logger.info('upsert_fornecedor_produto: POST vínculo OK', {
            service: 'bling-handler',
            empresa_id: job.empresa_id,
            jobId: job.id,
            produto_bling_id,
            fornecedor_bling_id,
            valor_de_compra
        });
    }
}

// ─── Handler: criar_produto ──────────────────────────────────────────────────
//
// Cria produto novo no Bling (se ainda não existe) + vínculo com fornecedor +
// preço. Salva o `id_produto_bling` retornado em `produtos` no Supabase.
//
// Payload esperado:
//   { produto_id, produto_bling_id, fornecedor_bling_id, nome, codigo, gtin,
//     unidade, itens_por_caixa, valor_de_compra }
async function handleCriarProduto(job /*, ctx */) {
    const {
        produto_id,
        produto_bling_id,
        fornecedor_bling_id,
        nome,
        codigo,
        gtin,
        unidade,
        itens_por_caixa,
        valor_de_compra
    } = job.payload || {};

    if (!nome && !produto_bling_id) {
        throw new Error('payload precisa de produto_bling_id existente OU nome para criar');
    }

    const accessToken = await getValidBlingToken(job.empresa_id);

    let blingId = produto_bling_id ? Number(produto_bling_id) : null;

    if (!blingId) {
        // Cria produto novo no Bling
        const corpo = {
            nome,
            tipo: 'P',          // Produto (P=produto, S=serviço)
            formato: 'S',       // Simples
            unidade: unidade || 'UN'
        };
        if (codigo) corpo.codigo = codigo;
        if (gtin) corpo.gtin = gtin;
        if (itens_por_caixa && itens_por_caixa > 1) corpo.itensPorCaixa = itens_por_caixa;

        const created = await blingFetch('POST', '/produtos', accessToken, corpo);
        const novoId = created?.data?.id;
        if (!novoId) {
            throw new Error(`Bling POST /produtos não retornou id (resposta: ${JSON.stringify(created || {}).slice(0, 200)})`);
        }
        blingId = Number(novoId);

        // Salva id_produto_bling no Supabase
        if (produto_id) {
            const { error: updErr } = await supabase
                .from('produtos')
                .update({
                    id_produto_bling: String(blingId),
                    dados_atualizados_em: new Date().toISOString(),
                    dados_origem: 'catalogo'
                })
                .eq('id', produto_id);
            if (updErr) {
                logger.warn('Falha ao salvar id_produto_bling no Supabase (não fatal)', {
                    service: 'bling-handler',
                    empresa_id: job.empresa_id,
                    jobId: job.id,
                    produto_id,
                    blingId,
                    error: updErr.message
                });
            }
        }

        logger.info('criar_produto: produto criado no Bling', {
            service: 'bling-handler',
            empresa_id: job.empresa_id,
            jobId: job.id,
            produto_id,
            blingId
        });
    }

    // Cria/atualiza vínculo fornecedor + preço (mesma lógica do upsert)
    if (fornecedor_bling_id && Number(valor_de_compra) > 0) {
        await handleUpsertFornecedorProduto({
            ...job,
            payload: {
                produto_id,
                produto_bling_id: blingId,
                fornecedor_bling_id,
                valor_de_compra
            }
        });
    } else {
        logger.info('criar_produto: vínculo fornecedor não criado (sem fornecedor_bling_id ou preço)', {
            service: 'bling-handler',
            empresa_id: job.empresa_id,
            jobId: job.id,
            produto_id,
            blingId,
            fornecedor_bling_id,
            valor_de_compra
        });
    }
}

// ─── Handler: upsert_produto ─────────────────────────────────────────────────
//
// Atualiza dados do produto (nome/marca/unidade/etc) no Bling.
//
// Payload esperado:
//   { produto_bling_id, nome?, marca?, unidade?, itens_por_caixa?, gtin?, codigo? }
async function handleUpsertProduto(job /*, ctx */) {
    const { produto_bling_id, nome, marca, unidade, itens_por_caixa, gtin, codigo } = job.payload || {};

    if (!produto_bling_id) {
        throw new Error('payload.produto_bling_id ausente');
    }

    const corpo = {};
    if (nome) corpo.nome = nome;
    if (marca) corpo.marca = marca;
    if (unidade) corpo.unidade = unidade;
    if (itens_por_caixa) corpo.itensPorCaixa = itens_por_caixa;
    if (gtin) corpo.gtin = gtin;
    if (codigo) corpo.codigo = codigo;

    if (Object.keys(corpo).length === 0) {
        logger.warn('upsert_produto: nenhum campo pra atualizar — pulando', {
            service: 'bling-handler',
            empresa_id: job.empresa_id,
            jobId: job.id
        });
        return;
    }

    const accessToken = await getValidBlingToken(job.empresa_id);

    await blingFetch(
        'PUT',
        `/produtos/${encodeURIComponent(produto_bling_id)}`,
        accessToken,
        corpo
    );

    logger.info('upsert_produto: PUT OK', {
        service: 'bling-handler',
        empresa_id: job.empresa_id,
        jobId: job.id,
        produto_bling_id,
        campos: Object.keys(corpo)
    });
}

/**
 * Registra todos os handlers no blingQueueProcessor.
 * Chamado pelo server.js no startup, antes de start() do worker.
 */
function registerHandlers() {
    const { blingQueueProcessor } = require("./blingQueueService");

    blingQueueProcessor.registerHandler('upsert_fornecedor_produto', handleUpsertFornecedorProduto);
    blingQueueProcessor.registerHandler('upsert_produto', handleUpsertProduto);
    blingQueueProcessor.registerHandler('criar_produto', handleCriarProduto);

    logger.info('Bling handlers registrados (implementação real ativa)', {
        service: 'bling-handler'
    });
}

module.exports = {
    registerHandlers,
    handleUpsertFornecedorProduto,
    handleCriarProduto,
    handleUpsertProduto,
    blingFetch  // exportado pra testes
};
