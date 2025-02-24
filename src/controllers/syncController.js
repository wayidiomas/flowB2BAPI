// src/controllers/syncController.js
const syncService = require("../services/syncService");

exports.syncFirstTime = async (req, res) => {
    try {
        const { empresa_id, accessToken, refresh_token, paginaAtual = 1 } = req.body;

        if (!empresa_id || !accessToken || !refresh_token) {
            return res.status(400).json({
                error: "Os parâmetros obrigatórios são: empresa_id, accessToken, refresh_token"
            });
        }

        // Responde imediatamente
        res.status(202).json({
            message: "Sincronização first-time iniciada com sucesso. O processo está em execução em background."
        });

        // Processa em background
        setImmediate(async () => {
            try {
                await syncService.handleFirstTimeSync({
                    empresa_id: Number(empresa_id),
                    accessToken,
                    refresh_token,
                    paginaAtual
                });
            } catch (error) {
                console.error("[ERROR] Background syncFirstTime:", error.message);
            }
        });
    } catch (error) {
        console.error("[ERROR] syncFirstTime:", error.message);
        return res.status(500).json({ error: "Erro interno ao iniciar sincronização first-time." });
    }
};

exports.syncDaily = async (req, res) => {
    try {
        const { empresa_id, accessToken, refresh_token } = req.body;

        if (!empresa_id || !accessToken || !refresh_token) {
            return res.status(400).json({
                error: "Os parâmetros obrigatórios são: empresa_id, accessToken, refresh_token."
            });
        }

        // Responde imediatamente
        res.status(202).json({
            message: "Sincronização diária iniciada com sucesso. O processo está em execução em background."
        });

        // Processa em background
        setImmediate(async () => {
            try {
                await syncService.handleDailySync({
                    empresa_id: Number(empresa_id),
                    accessToken,
                    refresh_token
                });
            } catch (error) {
                console.error("[ERROR] Background syncDaily:", error.message);
            }
        });
    } catch (error) {
        console.error("[ERROR] syncDaily:", error.message);
        return res.status(500).json({ error: "Erro interno ao iniciar sincronização diária." });
    }
};

exports.syncInventory = async (req, res) => {
    try {
        const { empresa_id, accessToken, refresh_token } = req.body;

        if (!empresa_id || !accessToken || !refresh_token) {
            return res.status(400).json({
                error: "Os parâmetros obrigatórios são: empresa_id, accessToken, refresh_token."
            });
        }

        // Responde imediatamente
        res.status(202).json({
            message: "Sincronização de estoque iniciada com sucesso. O processo está em execução em background."
        });

        // Processa em background
        setImmediate(async () => {
            try {
                await syncService.handleInventorySync({
                    empresa_id: Number(empresa_id),
                    accessToken,
                    refresh_token
                });
            } catch (error) {
                console.error("[ERROR] Background syncInventory:", error.message);
            }
        });
    } catch (error) {
        console.error("[ERROR] syncInventory:", error.message);
        return res.status(500).json({ error: "Erro interno ao iniciar sincronização de estoque." });
    }
};
