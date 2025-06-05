// src/services/blingTokenService.js
const axios = require("axios");
const FormData = require("form-data");
const supabase = require("./supabaseService");

class TokenManager {
    constructor() {
        this.renewalIntervals = new Map();
        this.renewalMutex = new Map(); // Previne renovações concorrentes
        this.TOKEN_RENEWAL_INTERVAL = 60 * 60 * 1000; // 1 hora
        this.TOKEN_EXPIRATION_BUFFER = 10 * 60 * 1000; // 10 minutos (reduzido)
    }

    /**
     * Obtém token válido com controle de concorrência
     */
    async getValidToken(empresa_id, accessToken = null, refresh_token = null) {
        const key = `empresa_${empresa_id}`;
        
        // Previne renovações concorrentes
        if (this.renewalMutex.has(key)) {
            console.log(`⏳ Aguardando renovação em progresso para empresa ${empresa_id}`);
            await this.renewalMutex.get(key);
        }

        try {
            const tokenData = await this._getTokenFromDB(empresa_id);
            
            if (!tokenData || !tokenData.expires_at) {
                return await this._renewToken(empresa_id, refresh_token || tokenData?.refresh_token);
            }

            const expiresAt = new Date(tokenData.expires_at);
            const now = new Date();
            const timeUntilExpiry = expiresAt.getTime() - now.getTime();

            // Só renova se realmente precisar
            if (timeUntilExpiry <= this.TOKEN_EXPIRATION_BUFFER) {
                console.log(`🔄 Token expira em ${Math.round(timeUntilExpiry/1000/60)} minutos. Renovando...`);
                return await this._renewToken(empresa_id, tokenData.refresh_token);
            }

            // Garante que o agendamento está ativo
            this._scheduleRenewal(empresa_id, tokenData.refresh_token, timeUntilExpiry);
            
            return tokenData.access_token;
        } catch (error) {
            console.error(`❌ Erro ao obter token para empresa ${empresa_id}:`, error);
            throw error;
        }
    }

    /**
     * Renova token com mutex para evitar concorrência
     */
    async _renewToken(empresa_id, refresh_token) {
        const key = `empresa_${empresa_id}`;
        
        // Se já está renovando, aguarda
        if (this.renewalMutex.has(key)) {
            await this.renewalMutex.get(key);
            return await this._getTokenFromDB(empresa_id);
        }

        // Cria mutex
        const renewalPromise = this._performRenewal(empresa_id, refresh_token);
        this.renewalMutex.set(key, renewalPromise);

        try {
            const result = await renewalPromise;
            return result.access_token;
        } finally {
            // Remove mutex
            this.renewalMutex.delete(key);
        }
    }

    /**
     * Executa a renovação real
     */
    async _performRenewal(empresa_id, refresh_token) {
        console.log(`🔄 Renovando token para empresa ${empresa_id}...`);

        const formData = new FormData();
        formData.append("grant_type", "refresh_token");
        formData.append("refresh_token", refresh_token);

        const response = await axios.post(
            "https://www.bling.com.br/Api/v3/oauth/token",
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    Accept: "1.0",
                    Authorization: `Basic ${process.env.BLING_AUTHORIZATION}`,
                },
                timeout: 30000 // 30 segundos timeout
            }
        );

        const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;
        const expires_at = new Date(Date.now() + expires_in * 1000);

        // Salva no banco
        await this._saveTokenToDB(empresa_id, access_token, new_refresh_token, expires_at);

        // Agenda próxima renovação
        this._scheduleRenewal(empresa_id, new_refresh_token, expires_in * 1000);

        console.log(`✅ Token renovado para empresa ${empresa_id}`);
        return { access_token, refresh_token: new_refresh_token, expires_at };
    }

    /**
     * Agenda renovação com limpeza automática
     */
    _scheduleRenewal(empresa_id, refresh_token, timeUntilExpiry) {
        // Limpa agendamento anterior
        this.clearRenewal(empresa_id);

        // Agenda para 10 minutos antes de expirar
        const renewalTime = Math.max(timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER, 60000);
        
        console.log(`⏰ Agendando renovação para empresa ${empresa_id} em ${Math.round(renewalTime/1000/60)} minutos`);
        
        const intervalId = setTimeout(async () => {
            try {
                await this._renewToken(empresa_id, refresh_token);
            } catch (error) {
                console.error(`❌ Erro na renovação agendada para empresa ${empresa_id}:`, error);
                // Remove da lista se falhou
                this.clearRenewal(empresa_id);
            }
        }, renewalTime);

        this.renewalIntervals.set(empresa_id, intervalId);
    }

    /**
     * Limpa agendamento específico
     */
    clearRenewal(empresa_id) {
        const intervalId = this.renewalIntervals.get(empresa_id);
        if (intervalId) {
            clearTimeout(intervalId);
            this.renewalIntervals.delete(empresa_id);
            console.log(`🧹 Limpeza de renovação para empresa ${empresa_id}`);
        }
    }

    /**
     * Limpa todos os agendamentos
     */
    clearAllRenewals() {
        console.log(`🧹 Limpando ${this.renewalIntervals.size} agendamentos de renovação...`);
        for (const [empresa_id, intervalId] of this.renewalIntervals) {
            clearTimeout(intervalId);
        }
        this.renewalIntervals.clear();
        this.renewalMutex.clear();
    }

    /**
     * Busca token no banco
     */
    async _getTokenFromDB(empresa_id) {
        const { data, error } = await supabase
            .from("bling_tokens")
            .select("access_token, refresh_token, expires_at")
            .eq("empresa_id", empresa_id)
            .maybeSingle();

        if (error) throw error;
        return data;
    }

    /**
     * Salva token no banco
     */
    async _saveTokenToDB(empresa_id, access_token, refresh_token, expires_at) {
        const { error } = await supabase.from("bling_tokens").upsert(
            {
                empresa_id,
                access_token,
                refresh_token,
                expires_at: expires_at.toISOString(),
                updated_at: new Date().toISOString()
            },
            { onConflict: ["empresa_id"] }
        );

        if (error) throw error;
    }
}

// Instância singleton
const tokenManager = new TokenManager();

module.exports = {
    getValidBlingToken: (empresa_id, accessToken, refresh_token) => 
        tokenManager.getValidToken(empresa_id, accessToken, refresh_token),
    clearAllRenewalIntervals: () => tokenManager.clearAllRenewals(),
    clearRenewalInterval: (empresa_id) => tokenManager.clearRenewal(empresa_id)
};