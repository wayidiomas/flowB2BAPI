// src/routes/syncRoutes.js
const express = require("express");
const router = express.Router();
const syncController = require("../controllers/syncController");

// ===========================
// ROTAS DE SINCRONIZAÇÃO (EXISTENTES)
// ===========================

/**
 * @swagger
 * /api/sync/first-time:
 *   post:
 *     summary: Sincroniza os dados pela primeira vez
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               empresa_id:
 *                 type: integer
 *                 description: ID da empresa
 *                 example: 123
 *               accessToken:
 *                 type: string
 *                 description: Token de acesso do Bling
 *               refresh_token:
 *                 type: string
 *                 description: Token de atualização do Bling
 *               paginaAtual:
 *                 type: integer
 *                 description: Página inicial para sincronização (opcional)
 *                 example: 1
 *                 default: 1
 *             required:
 *               - empresa_id
 *               - accessToken
 *               - refresh_token
 *     responses:
 *       202:
 *         description: Sincronização first-time iniciada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Sincronização first-time iniciada com sucesso. O processo está em execução em background."
 *                 empresa_id:
 *                   type: integer
 *                   example: 123
 *                 statusEndpoint:
 *                   type: string
 *                   example: "/api/sync/status/123"
 *                 cancelEndpoint:
 *                   type: string
 *                   example: "/api/sync/cancel/123"
 *       400:
 *         description: Parâmetros inválidos
 *       409:
 *         description: Sincronização do mesmo tipo já em andamento
 *       500:
 *         description: Erro interno do servidor
 */
router.post("/first-time", syncController.syncFirstTime);

/**
 * @swagger
 * /api/sync/first-time-from-step:
 *   post:
 *     summary: Sincroniza os dados first-time a partir de uma etapa específica
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               empresa_id:
 *                 type: integer
 *                 description: ID da empresa
 *                 example: 123
 *               accessToken:
 *                 type: string
 *                 description: Token de acesso do Bling
 *               refresh_token:
 *                 type: string
 *                 description: Token de atualização do Bling
 *               startFromStep:
 *                 type: string
 *                 description: Etapa inicial da sincronização
 *                 enum: [produtos, fornecedores, pedidos-venda, pedidos-compra, notas-fiscais]
 *                 example: "pedidos-venda"
 *               paginaAtual:
 *                 type: integer
 *                 description: Página inicial para sincronização (opcional)
 *                 example: 1
 *                 default: 1
 *             required:
 *               - empresa_id
 *               - accessToken
 *               - refresh_token
 *               - startFromStep
 *     responses:
 *       202:
 *         description: Sincronização first-time iniciada a partir da etapa especificada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Sincronização first-time iniciada a partir da etapa 'pedidos-venda'. O processo está em execução em background."
 *                 empresa_id:
 *                   type: integer
 *                   example: 123
 *                 startFromStep:
 *                   type: string
 *                   example: "pedidos-venda"
 *                 skippedSteps:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["produtos", "fornecedores"]
 *                 statusEndpoint:
 *                   type: string
 *                   example: "/api/sync/status/123"
 *                 cancelEndpoint:
 *                   type: string
 *                   example: "/api/sync/cancel/123/first-time"
 *       400:
 *         description: Parâmetros inválidos ou etapa não reconhecida
 *       409:
 *         description: Sincronização do mesmo tipo já em andamento
 *       500:
 *         description: Erro interno do servidor
 */
router.post("/first-time-from-step", syncController.syncFirstTimeFromStep);

/**
 * @swagger
 * /api/sync/daily:
 *   post:
 *     summary: Realiza a sincronização diária
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               empresa_id:
 *                 type: integer
 *                 description: ID da empresa
 *                 example: 123
 *               accessToken:
 *                 type: string
 *                 description: Token de acesso do Bling
 *               refresh_token:
 *                 type: string
 *                 description: Token de atualização do Bling
 *             required:
 *               - empresa_id
 *               - accessToken
 *               - refresh_token
 *     responses:
 *       202:
 *         description: Sincronização diária iniciada com sucesso
 *       400:
 *         description: Parâmetros inválidos
 *       409:
 *         description: Sincronização do mesmo tipo já em andamento
 *       500:
 *         description: Erro interno do servidor
 */
router.post("/daily", syncController.syncDaily);

/**
 * @swagger
 * /api/sync/inventory:
 *   post:
 *     summary: Sincroniza os dados de estoque
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               empresa_id:
 *                 type: integer
 *                 description: ID da empresa
 *                 example: 123
 *               accessToken:
 *                 type: string
 *                 description: Token de acesso do Bling
 *               refresh_token:
 *                 type: string
 *                 description: Token de atualização do Bling
 *             required:
 *               - empresa_id
 *               - accessToken
 *               - refresh_token
 *     responses:
 *       202:
 *         description: Sincronização de estoque iniciada com sucesso
 *       400:
 *         description: Parâmetros inválidos
 *       409:
 *         description: Sincronização do mesmo tipo já em andamento
 *       500:
 *         description: Erro interno do servidor
 */
router.post("/inventory", syncController.syncInventory);

// ===========================
// ROTAS DE MONITORAMENTO (NOVAS)
// ===========================

/**
 * @swagger
 * /api/sync/status/{empresa_id}:
 *   get:
 *     summary: Obtém status de todas as sincronizações ativas de uma empresa
 *     tags: [Monitoramento]
 *     parameters:
 *       - in: path
 *         name: empresa_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID da empresa
 *         example: 123
 *     responses:
 *       200:
 *         description: Status das sincronizações da empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 empresa_id:
 *                   type: integer
 *                   example: 123
 *                 activeSyncs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       syncType:
 *                         type: string
 *                         example: "daily"
 *                       operation:
 *                         type: string
 *                         example: "incremental-sync"
 *                       currentStep:
 *                         type: string
 *                         example: "produtos"
 *                       recordsProcessed:
 *                         type: integer
 *                         example: 1500
 *                       startTime:
 *                         type: string
 *                         format: date-time
 *                 totalActiveSyncs:
 *                   type: integer
 *                   example: 2
 *       400:
 *         description: empresa_id inválido
 *       500:
 *         description: Erro interno do servidor
 */
router.get("/status/:empresa_id", syncController.getSyncStatus);

/**
 * @swagger
 * /api/sync/active:
 *   get:
 *     summary: Lista todas as sincronizações ativas no sistema
 *     tags: [Monitoramento]
 *     responses:
 *       200:
 *         description: Lista de todas as sincronizações ativas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeSyncsCount:
 *                   type: integer
 *                   example: 5
 *                 activeSyncs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       empresa_id:
 *                         type: integer
 *                         example: 123
 *                       syncType:
 *                         type: string
 *                         example: "daily"
 *                       operation:
 *                         type: string
 *                         example: "incremental-sync"
 *                       currentStep:
 *                         type: string
 *                         example: "produtos"
 *                       recordsProcessed:
 *                         type: integer
 *                         example: 1500
 *                       startTime:
 *                         type: string
 *                         format: date-time
 *                 systemMetrics:
 *                   type: object
 *                   properties:
 *                     totalSyncs:
 *                       type: integer
 *                       example: 45
 *                     systemMemoryMB:
 *                       type: integer
 *                       example: 512
 *                     uptimeSeconds:
 *                       type: integer
 *                       example: 86400
 *       500:
 *         description: Erro interno do servidor
 */
router.get("/active", syncController.getAllActiveSyncs);

/**
 * @swagger
 * /api/sync/cancel/{empresa_id}/{syncType}:
 *   post:
 *     summary: Cancela sincronização específica em andamento
 *     tags: [Monitoramento]
 *     parameters:
 *       - in: path
 *         name: empresa_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID da empresa
 *         example: 123
 *       - in: path
 *         name: syncType
 *         required: true
 *         schema:
 *           type: string
 *           enum: [first-time, daily, inventory]
 *         description: Tipo da sincronização a cancelar
 *         example: "daily"
 *     responses:
 *       200:
 *         description: Sincronização cancelada com sucesso
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Sincronização cancelada com sucesso"
 *                 empresa_id:
 *                   type: integer
 *                   example: 123
 *                 syncType:
 *                   type: string
 *                   example: "daily"
 *                 cancelledAt:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Parâmetros inválidos
 *       404:
 *         description: Sincronização não encontrada
 *       500:
 *         description: Erro interno do servidor
 */
router.post("/cancel/:empresa_id/:syncType", syncController.cancelSync);

/**
 * @swagger
 * /api/sync/performance/{empresa_id}:
 *   get:
 *     summary: Obtém histórico de performance de sincronizações de uma empresa
 *     tags: [Monitoramento]
 *     parameters:
 *       - in: path
 *         name: empresa_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID da empresa
 *         example: 123
 *     responses:
 *       200:
 *         description: Histórico de performance da empresa
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 empresa_id:
 *                   type: integer
 *                   example: 123
 *                 activeSyncs:
 *                   type: array
 *                   description: Sincronizações atualmente ativas
 *                 history:
 *                   type: array
 *                   description: Histórico das últimas 10 sincronizações
 *                   items:
 *                     type: object
 *                     properties:
 *                       syncType:
 *                         type: string
 *                         example: "daily"
 *                       status:
 *                         type: string
 *                         example: "completed"
 *                       duration:
 *                         type: integer
 *                         example: 1800000
 *                       recordsProcessed:
 *                         type: integer
 *                         example: 1500
 *                       errorsCount:
 *                         type: integer
 *                         example: 2
 *                 totalActiveSyncs:
 *                   type: integer
 *                   example: 2
 *       400:
 *         description: empresa_id inválido
 *       404:
 *         description: Empresa não encontrada
 *       500:
 *         description: Erro interno do servidor
 */
router.get("/performance/:empresa_id", syncController.getSyncPerformance);

/**
 * @swagger
 * /api/sync/performance:
 *   get:
 *     summary: Obtém métricas globais de performance do sistema
 *     tags: [Monitoramento]
 *     responses:
 *       200:
 *         description: Métricas globais do sistema
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 systemOverview:
 *                   type: object
 *                   description: Métricas gerais do sistema
 *                 activeSyncs:
 *                   type: array
 *                   description: Todas as sincronizações ativas
 *                 byCompany:
 *                   type: object
 *                   description: Métricas agrupadas por empresa
 *       500:
 *         description: Erro interno do servidor
 */
router.get("/performance", syncController.getSyncPerformance);

module.exports = router;