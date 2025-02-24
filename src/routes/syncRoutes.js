// src/routes/syncRoutes.js
const express = require("express");
const router = express.Router();
const syncController = require("../controllers/syncController");

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
 *               accessToken:
 *                 type: string
 *               refresh_token:
 *                 type: string
 *             required:
 *               - empresa_id
 *               - accessToken
 *               - refresh_token
 *     responses:
 *       200:
 *         description: Sincronização first-time bem-sucedida
 *       400:
 *         description: Requisição inválida
 */
router.post("/first-time", syncController.syncFirstTime);

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
 *               accessToken:
 *                 type: string
 *               refresh_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Sincronização diária bem-sucedida
 *       400:
 *         description: Requisição inválida
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
 *               accessToken:
 *                 type: string
 *               refresh_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Sincronização de estoque bem-sucedida
 *       400:
 *         description: Requisição inválida
 */
router.post("/inventory", syncController.syncInventory);

module.exports = router;
