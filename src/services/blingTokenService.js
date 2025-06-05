// src/services/blingTokenService.js
const axios = require("axios");
const FormData = require("form-data");
const supabase = require("./supabaseService");
const { TOKEN } = require("../config/SyncConfig");
const { 
  createTokenContext, 
  logError, 
  logOperationStart, 
  logOperationEnd,
  sanitizeData 
} = require("../utils/logger");
const { 
  waitForToken, 
  rateLimiterManager,
  withBlingRateLimit 
} = require("../utils/rateLimiter");

class TokenManager {
    constructor() {
        this.renewalIntervals = new Map();
        this.renewalMutex = new Map(); // Previne renovações concorrentes
        
        // Usa configurações centralizadas
        this.TOKEN_RENEWAL_INTERVAL = TOKEN.RENEWAL_INTERVAL;
        this.TOKEN_EXPIRATION_BUFFER = TOKEN.EXPIRATION_BUFFER;
        this.REQUEST_TIMEOUT = TOKEN.REQUEST_TIMEOUT;
        
        // Estatísticas do token manager
        this.stats = {
            totalRenewals: 0,
            successfulRenewals: 0,
            failedRenewals: 0,
            averageRenewalTime: 0,
            lastRenewalTime: null
        };

        // Logger contexto para tokens
        this.logger = createTokenContext('system');
        
        this.logger.info('Token Manager inicializado', {
            renewalInterval: `${this.TOKEN_RENEWAL_INTERVAL}ms`,
            expirationBuffer: `${this.TOKEN_EXPIRATION_BUFFER}ms`,
            timeout: `${this.REQUEST_TIMEOUT}ms`
        });
    }

    /**
     * Obtém token válido com controle de concorrência
     */
    async getValidToken(empresa_id, accessToken = null, refresh_token = null) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        // Previne renovações concorrentes
        if (this.renewalMutex.has(key)) {
            logger.info('Aguardando renovação em progresso', {
                operation: 'getValidToken',
                status: 'waiting'
            });
            
            await this.renewalMutex.get(key);
        }

        try {
            const tokenData = await this._getTokenFromDB(empresa_id);
            
            if (!tokenData || !tokenData.expires_at) {
                logger.warn('Token não encontrado ou sem data de expiração', {
                    hasToken: !!tokenData,
                    hasExpiresAt: !!tokenData?.expires_at
                });
                
                return await this._renewToken(empresa_id, refresh_token || tokenData?.refresh_token);
            }

            const expiresAt = new Date(tokenData.expires_at);
            const now = new Date();
            const timeUntilExpiry = expiresAt.getTime() - now.getTime();

            // Só renova se realmente precisar
            if (timeUntilExpiry <= this.TOKEN_EXPIRATION_BUFFER) {
                const minutesUntilExpiry = Math.round(timeUntilExpiry / 1000 / 60);
                
                logger.info('Token próximo do vencimento, renovando', {
                    operation: 'getValidToken',
                    minutesUntilExpiry,
                    expiresAt: expiresAt.toISOString()
                });
                
                return await this._renewToken(empresa_id, tokenData.refresh_token);
            }

            // Garante que o agendamento está ativo
            this._scheduleRenewal(empresa_id, tokenData.refresh_token, timeUntilExpiry);
            
            logger.debug('Token válido obtido', {
                operation: 'getValidToken',
                minutesUntilExpiry: Math.round(timeUntilExpiry / 1000 / 60),
                tokenPreview: `${tokenData.access_token.substring(0, 8)}***`
            });
            
            return tokenData.access_token;
        } catch (error) {
            logError(error, 'getValidToken', { empresa_id });
            throw error;
        }
    }

    /**
     * Renova token com mutex para evitar concorrência
     */
    async _renewToken(empresa_id, refresh_token) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        // Se já está renovando, aguarda
        if (this.renewalMutex.has(key)) {
            logger.debug('Aguardando renovação já em progresso');
            await this.renewalMutex.get(key);
            
            // Busca token atualizado do banco
            const tokenData = await this._getTokenFromDB(empresa_id);
            return tokenData?.access_token;
        }

        // Cria mutex e registra no rate limiter
        const renewalPromise = this._performRenewal(empresa_id, refresh_token);
        this.renewalMutex.set(key, renewalPromise);
        
        // Registra no rate limiter para controle de concorrência
        rateLimiterManager.startTokenRenewal(empresa_id, renewalPromise);

        try {
            const result = await renewalPromise;
            return result.access_token;
        } finally {
            // Remove mutex
            this.renewalMutex.delete(key);
        }
    }

    /**
     * Executa a renovação real com rate limiting e logging
     */
    async _performRenewal(empresa_id, refresh_token) {
        const logger = createTokenContext(empresa_id);
        const startTime = Date.now();
        
        logOperationStart('tokenRenewal', { 
            empresa_id,
            refreshTokenPreview: refresh_token ? `${refresh_token.substring(0, 8)}***` : null
        });

        try {
            // Aplica rate limiting antes da renovação
            await waitForToken(empresa_id);
            
            logger.info('Iniciando renovação de token', {
                operation: 'performRenewal'
            });

            // Wrapper com rate limiting do Bling
            const result = await withBlingRateLimit(async () => {
                const formData = new FormData();
                formData.append("grant_type", "refresh_token");
                formData.append("refresh_token", refresh_token);

                const response = await axios.post(
                    "https://www.bling.com.br/Api/v3/oauth/token",
                    formData,
                    {
                        headers: {
                            ...formData.getHeaders(),
                            ...TOKEN.DEFAULT_HEADERS,
                            Authorization: `Basic ${process.env.BLING_AUTHORIZATION}`,
                        },
                        timeout: this.REQUEST_TIMEOUT
                    }
                );

                return response.data;
            });

            const { access_token, refresh_token: new_refresh_token, expires_in } = result;
            const expires_at = new Date(Date.now() + expires_in * 1000);

            // Salva no banco
            await this._saveTokenToDB(empresa_id, access_token, new_refresh_token, expires_at);

            // Agenda próxima renovação
            this._scheduleRenewal(empresa_id, new_refresh_token, expires_in * 1000);

            // Atualiza estatísticas
            const renewalTime = Date.now() - startTime;
            this._updateStats(true, renewalTime);

            const tokenResult = { access_token, refresh_token: new_refresh_token, expires_at };
            
            logOperationEnd('tokenRenewal', true, {
                empresa_id,
                renewalTime: `${renewalTime}ms`,
                expiresAt: expires_at.toISOString(),
                tokenPreview: `${access_token.substring(0, 8)}***`
            });

            logger.info('Token renovado com sucesso', {
                operation: 'performRenewal',
                renewalTime: `${renewalTime}ms`,
                expiresIn: `${expires_in}s`
            });

            return tokenResult;

        } catch (error) {
            // Atualiza estatísticas de erro
            const renewalTime = Date.now() - startTime;
            this._updateStats(false, renewalTime);

            logOperationEnd('tokenRenewal', false, {
                empresa_id,
                renewalTime: `${renewalTime}ms`,
                error: error.message
            });

            logError(error, 'performRenewal', { 
                empresa_id,
                refreshTokenProvided: !!refresh_token
            });

            throw error;
        }
    }

    /**
     * Agenda renovação com limpeza automática
     */
    _scheduleRenewal(empresa_id, refresh_token, timeUntilExpiry) {
        const logger = createTokenContext(empresa_id);
        
        // Limpa agendamento anterior
        this.clearRenewal(empresa_id);

        // Agenda para X minutos antes de expirar
        const renewalTime = Math.max(timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER, 60000);
        const renewalMinutes = Math.round(renewalTime / 1000 / 60);
        
        logger.info('Agendando renovação automática', {
            operation: 'scheduleRenewal',
            renewalInMinutes: renewalMinutes,
            renewalAt: new Date(Date.now() + renewalTime).toISOString()
        });
        
        const intervalId = setTimeout(async () => {
            const scheduleLogger = createTokenContext(empresa_id);
            
            try {
                scheduleLogger.info('Executando renovação agendada');
                await this._renewToken(empresa_id, refresh_token);
            } catch (error) {
                logError(error, 'scheduledRenewal', { empresa_id });
                
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
            
            const logger = createTokenContext(empresa_id);
            logger.debug('Agendamento de renovação removido', {
                operation: 'clearRenewal'
            });
        }
    }

    /**
     * Limpa todos os agendamentos
     */
    clearAllRenewals() {
        const totalIntervals = this.renewalIntervals.size;
        
        this.logger.info('Limpando todos os agendamentos de renovação', {
            operation: 'clearAllRenewals',
            totalIntervals
        });
        
        for (const [empresa_id, intervalId] of this.renewalIntervals) {
            clearTimeout(intervalId);
        }
        
        this.renewalIntervals.clear();
        this.renewalMutex.clear();
        
        this.logger.info('Todos os agendamentos removidos', {
            operation: 'clearAllRenewals',
            clearedIntervals: totalIntervals
        });
    }

    /**
     * Busca token no banco com logging
     */
    async _getTokenFromDB(empresa_id) {
        const logger = createTokenContext(empresa_id);
        
        try {
            const { data, error } = await supabase
                .from("bling_tokens")
                .select("access_token, refresh_token, expires_at")
                .eq("empresa_id", empresa_id)
                .maybeSingle();

            if (error) throw error;
            
            logger.debug('Token recuperado do banco', {
                operation: 'getTokenFromDB',
                hasToken: !!data,
                expiresAt: data?.expires_at
            });
            
            return data;
        } catch (error) {
            logError(error, 'getTokenFromDB', { empresa_id });
            throw error;
        }
    }

    /**
     * Salva token no banco com logging
     */
    async _saveTokenToDB(empresa_id, access_token, refresh_token, expires_at) {
        const logger = createTokenContext(empresa_id);
        
        try {
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
            
            logger.debug('Token salvo no banco', {
                operation: 'saveTokenToDB',
                expiresAt: expires_at.toISOString()
            });
            
        } catch (error) {
            logError(error, 'saveTokenToDB', { 
                empresa_id,
                expiresAt: expires_at?.toISOString()
            });
            throw error;
        }
    }

    /**
     * Atualiza estatísticas do token manager
     */
    _updateStats(success, renewalTime) {
        this.stats.totalRenewals++;
        this.stats.lastRenewalTime = new Date().toISOString();
        
        if (success) {
            this.stats.successfulRenewals++;
        } else {
            this.stats.failedRenewals++;
        }
        
        // Calcula tempo médio de renovação
        this.stats.averageRenewalTime = (
            (this.stats.averageRenewalTime * (this.stats.totalRenewals - 1) + renewalTime) / 
            this.stats.totalRenewals
        );
    }

    /**
     * Obtém estatísticas do token manager
     */
    getStats() {
        return {
            ...this.stats,
            activeRenewals: this.renewalIntervals.size,
            pendingRenewals: this.renewalMutex.size,
            successRate: this.stats.totalRenewals > 0 
                ? (this.stats.successfulRenewals / this.stats.totalRenewals * 100).toFixed(2) + '%'
                : '0%',
            averageRenewalTime: Math.round(this.stats.averageRenewalTime) + 'ms'
        };
    }

    /**
     * Health check do token manager
     */
    getHealthStatus() {
        const stats = this.getStats();
        const recentFailures = this.stats.failedRenewals > this.stats.successfulRenewals * 0.1; // Mais de 10% de falhas
        
        return {
            status: recentFailures ? 'warning' : 'healthy',
            stats,
            timestamp: new Date().toISOString()
        };
    }
}

// Instância singleton
const tokenManager = new TokenManager();

// ===========================
// EXPORTAÇÕES
// ===========================

module.exports = {
    // Funções principais (compatibilidade mantida)
    getValidBlingToken: (empresa_id, accessToken, refresh_token) => 
        tokenManager.getValidToken(empresa_id, accessToken, refresh_token),
    clearAllRenewalIntervals: () => tokenManager.clearAllRenewals(),
    clearRenewalInterval: (empresa_id) => tokenManager.clearRenewal(empresa_id),
    
    // Novas funcionalidades
    getTokenManagerStats: () => tokenManager.getStats(),
    getTokenManagerHealth: () => tokenManager.getHealthStatus(),
    
    // Acesso à instância (para casos avançados)
    tokenManager
};