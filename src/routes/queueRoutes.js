// src/routes/queueRoutes.js
const express = require("express");
const router = express.Router();
const { blingQueueProcessor } = require("../services/blingQueueService");
const { logger } = require("../utils/logger");

/**
 * Middleware: header X-Internal-Secret obrigatório.
 * Se INTERNAL_QUEUE_SECRET não estiver configurado no .env, rejeita tudo
 * (fail-safe — preferimos bloquear do que aceitar requests sem auth).
 */
function requireInternalSecret(req, res, next) {
    const secret = process.env.INTERNAL_QUEUE_SECRET;
    if (!secret) {
        logger.error('INTERNAL_QUEUE_SECRET não configurado no .env — rejeitando request', {
            service: 'queue-route'
        });
        return res.status(500).json({ error: 'Servidor não configurado' });
    }

    const provided = req.headers['x-internal-secret'];
    if (provided !== secret) {
        logger.warn('Tentativa de acesso a /api/queue sem secret válido', {
            service: 'queue-route',
            ip: req.ip,
            hasHeader: !!provided
        });
        return res.status(401).json({ error: 'Não autorizado' });
    }
    next();
}

router.use(requireInternalSecret);

/**
 * @swagger
 * /api/queue/enqueue:
 *   post:
 *     summary: Enfileira um job de sync para o Bling
 *     tags: [Sistema]
 *     description: |
 *       Endpoint interno chamado pelo FlowB2B_Client para enfileirar operações
 *       que precisam ser sincronizadas com o Bling. Empresas sem Bling ativo
 *       retornam `{skipped: true}` — o caller decide se isso é erro ou OK.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               empresa_id: { type: integer }
 *               operacao: { type: string, enum: [upsert_fornecedor_produto, upsert_produto, criar_produto] }
 *               payload: { type: object }
 *               origem: { type: string }
 *               origem_ref_id: { type: integer }
 *               max_tentativas: { type: integer, default: 8 }
 *             required: [empresa_id, operacao]
 *     responses:
 *       202:
 *         description: Job enfileirado ou skipped
 *       400: { description: Parâmetros inválidos }
 *       401: { description: X-Internal-Secret inválido }
 *       500: { description: Erro interno }
 */
router.post('/enqueue', async (req, res) => {
    const { empresa_id, operacao, payload, origem, origem_ref_id, max_tentativas } = req.body || {};

    if (!Number.isInteger(empresa_id) || empresa_id <= 0) {
        return res.status(400).json({ error: 'empresa_id deve ser inteiro positivo' });
    }
    if (!operacao || typeof operacao !== 'string') {
        return res.status(400).json({ error: 'operacao obrigatória' });
    }
    if (payload != null && typeof payload !== 'object') {
        return res.status(400).json({ error: 'payload deve ser objeto' });
    }

    try {
        const result = await blingQueueProcessor.enqueue(empresa_id, operacao, payload || {}, {
            origem,
            origem_ref_id,
            max_tentativas
        });
        return res.status(202).json(result);
    } catch (err) {
        logger.error('Erro em /api/queue/enqueue', {
            service: 'queue-route',
            empresa_id,
            operacao,
            error: err.message
        });
        return res.status(500).json({ error: err.message });
    }
});

/**
 * @swagger
 * /api/queue/stats:
 *   get:
 *     summary: Estatísticas do worker da fila Bling
 *     tags: [Monitoramento]
 */
router.get('/stats', (req, res) => {
    return res.json(blingQueueProcessor.getStats());
});

module.exports = router;
