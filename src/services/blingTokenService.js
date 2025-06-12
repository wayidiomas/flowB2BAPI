// src/services/blingTokenService.js - VERSÃO CORRIGIDA
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
            lastRenewalTime: null,
            // ✅ NOVA MÉTRICA: Para tracking de problemas
            mutexTimeouts: 0,
            mutexClears: 0
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
     * ✅ FUNÇÃO CORRIGIDA: Obtém token válido com controle de concorrência
     */
    async getValidToken(empresa_id, accessToken = null, refresh_token = null) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        // 🐛 DEBUG: Log entrada da função
        logger.debug('getValidToken chamado', {
            operation: 'getValidToken',
            hasAccessToken: !!accessToken,
            hasRefreshToken: !!refresh_token,
            mutexExists: this.renewalMutex.has(key),
            activeRenewals: this.renewalIntervals.size
        });
        
        // ✅ FIX: Timeout para mutex travado
        if (this.renewalMutex.has(key)) {
            logger.info('Aguardando renovação em progresso', {
                operation: 'getValidToken',
                status: 'waiting'
            });
            
            try {
                // ✅ PROTEÇÃO: Timeout de 30 segundos para mutex
                const mutexPromise = this.renewalMutex.get(key);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Mutex timeout - possível deadlock')), 30000);
                });
                
                await Promise.race([mutexPromise, timeoutPromise]);
                
                // ✅ PÓS-MUTEX: Busca token atualizado do banco
                const updatedToken = await this._getTokenFromDB(empresa_id);
                if (updatedToken?.access_token) {
                    logger.debug('Token obtido após aguardar mutex', {
                        operation: 'getValidToken',
                        tokenPreview: `${updatedToken.access_token.substring(0, 8)}***`
                    });
                    
                    // ✅ REAGENDA: Garante que agendamento está ativo
                    if (updatedToken.expires_at) {
                        const expiresAt = new Date(updatedToken.expires_at);
                        const timeUntilExpiry = expiresAt.getTime() - Date.now();
                        if (timeUntilExpiry > this.TOKEN_EXPIRATION_BUFFER) {
                            this._scheduleRenewal(empresa_id, updatedToken.refresh_token, timeUntilExpiry);
                        }
                    }
                    
                    return updatedToken.access_token;
                }
                
            } catch (error) {
                // ✅ MUTEX TRAVADO: Remove e continua
                logger.warn('Mutex timeout ou erro, removendo mutex travado', {
                    operation: 'getValidToken',
                    error: error.message,
                    mutexKey: key
                });
                
                this.renewalMutex.delete(key);
                this.stats.mutexTimeouts++;
                
                // Continua com a lógica normal após remover mutex travado
            }
        }

        try {
            const tokenData = await this._getTokenFromDB(empresa_id);
            
            // 🐛 DEBUG: Log token do banco
            logger.debug('Token lido do banco', {
                operation: 'getValidToken',
                hasToken: !!tokenData,
                expiresAt: tokenData?.expires_at,
                tokenPreview: tokenData?.access_token ? `${tokenData.access_token.substring(0, 8)}***` : null
            });
            
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

            // 🐛 DEBUG: Log cálculo de expiração
            logger.debug('Cálculo de expiração', {
                operation: 'getValidToken',
                expiresAt: expiresAt.toISOString(),
                currentTime: now.toISOString(),
                timeUntilExpiry,
                timeUntilExpiryMinutes: Math.round(timeUntilExpiry / 1000 / 60),
                expirationBuffer: this.TOKEN_EXPIRATION_BUFFER,
                shouldRenew: timeUntilExpiry <= this.TOKEN_EXPIRATION_BUFFER
            });

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
     * ✅ FUNÇÃO CORRIGIDA: Renova token com mutex para evitar concorrência
     */
    async _renewToken(empresa_id, refresh_token) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        // 🐛 DEBUG: Log entrada da função
        logger.debug('_renewToken chamado', {
            operation: 'renewToken',
            hasRefreshToken: !!refresh_token,
            mutexExists: this.renewalMutex.has(key)
        });
        
        // Se já está renovando, aguarda COM TIMEOUT
        if (this.renewalMutex.has(key)) {
            logger.debug('Aguardando renovação já em progresso');
            
            try {
                const mutexPromise = this.renewalMutex.get(key);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Renewal mutex timeout')), 30000);
                });
                
                await Promise.race([mutexPromise, timeoutPromise]);
                
                // Busca token atualizado do banco
                const tokenData = await this._getTokenFromDB(empresa_id);
                return tokenData?.access_token;
                
            } catch (error) {
                logger.warn('Timeout em mutex de renovação, removendo', {
                    operation: 'renewToken',
                    error: error.message
                });
                
                this.renewalMutex.delete(key);
                this.stats.mutexTimeouts++;
                // Continua com renovação normal
            }
        }

        // Cria mutex e registra no rate limiter
        const renewalPromise = this._performRenewal(empresa_id, refresh_token);
        this.renewalMutex.set(key, renewalPromise);
        
        // Registra no rate limiter para controle de concorrência
        rateLimiterManager.startTokenRenewal(empresa_id, renewalPromise);

        try {
            const result = await renewalPromise;
            return result.access_token;
        } catch (error) {
            // ✅ LOG: Registra erro de renovação
            logger.error('Erro na renovação de token', {
                operation: 'renewToken',
                error: error.message
            });
            throw error;
        } finally {
            // ✅ GARANTIA: Remove mutex SEMPRE
            this.renewalMutex.delete(key);
            this.stats.mutexClears++;
            
            logger.debug('Mutex removido', {
                operation: 'renewToken',
                mutexKey: key
            });
        }
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Executa a renovação real com rate limiting e logging
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

            // 🐛 DEBUG: Log dados da resposta do Bling
            logger.debug('Resposta do Bling recebida', {
                operation: 'performRenewal',
                expires_in,
                expires_at: expires_at.toISOString(),
                tokenPreview: `${access_token.substring(0, 8)}***`
            });

            // ✅ SALVA: No banco com validação
            await this._saveTokenToDB(empresa_id, access_token, new_refresh_token, expires_at);

            // ✅ FIX: Usa timeUntilExpiry correto, não expires_in * 1000
            const timeUntilExpiry = expires_at.getTime() - Date.now();
            this._scheduleRenewal(empresa_id, new_refresh_token, timeUntilExpiry);

            // Atualiza estatísticas
            const renewalTime = Date.now() - startTime;
            this._updateStats(true, renewalTime);

            const tokenResult = { access_token, refresh_token: new_refresh_token, expires_at };
            
            logOperationEnd('tokenRenewal', true, {
                empresa_id,
                renewalTime: `${renewalTime}ms`,
                expiresAt: expires_at.toISOString(),
                tokenPreview: `${access_token.substring(0, 8)}***`,
                expires_in
            });

            logger.info('Token renovado com sucesso', {
                operation: 'performRenewal',
                renewalTime: `${renewalTime}ms`,
                expiresIn: `${expires_in}s`,
                expiresAt: expires_at.toISOString()
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
     * ✅ FUNÇÃO CORRIGIDA: Agenda renovação com limpeza automática
     */
    _scheduleRenewal(empresa_id, refresh_token, timeUntilExpiry) {
        const logger = createTokenContext(empresa_id);
        
        // 🐛 DEBUG: Log entrada da função
        const debugInfo = {
            empresa_id,
            timeUntilExpiry,
            timeUntilExpiryMinutes: Math.round(timeUntilExpiry / 1000 / 60),
            expirationBuffer: this.TOKEN_EXPIRATION_BUFFER,
            expirationBufferMinutes: Math.round(this.TOKEN_EXPIRATION_BUFFER / 1000 / 60),
            currentTime: new Date().toISOString()
        };
        
        logger.debug('_scheduleRenewal chamado', {
            operation: 'scheduleRenewal',
            ...debugInfo
        });
        
        // ✅ VALIDAÇÃO: Verifica se timeUntilExpiry é válido
        if (!timeUntilExpiry || timeUntilExpiry <= 0 || !isFinite(timeUntilExpiry)) {
            logger.error('timeUntilExpiry inválido, não agendando renovação', {
                operation: 'scheduleRenewal',
                timeUntilExpiry,
                debugInfo
            });
            return;
        }
        
        // Limpa agendamento anterior
        this.clearRenewal(empresa_id);

        // Agenda para X minutos antes de expirar
        const renewalTime = Math.max(timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER, 60000);
        const renewalMinutes = Math.round(renewalTime / 1000 / 60);
        const renewalAt = new Date(Date.now() + renewalTime);
        
        // 🐛 DEBUG: Log cálculo do agendamento
        logger.debug('Cálculo de agendamento', {
            operation: 'scheduleRenewal',
            renewalTime,
            renewalMinutes,
            renewalAt: renewalAt.toISOString(),
            calculation: {
                step1_timeUntilExpiry: timeUntilExpiry,
                step2_minusBuffer: timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER,
                step3_maxWith60s: Math.max(timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER, 60000),
                step4_finalTimestamp: Date.now() + renewalTime
            }
        });
        
        logger.info('Agendando renovação automática', {
            operation: 'scheduleRenewal',
            renewalInMinutes: renewalMinutes,
            renewalAt: renewalAt.toISOString()
        });
        
        const intervalId = setTimeout(async () => {
            const scheduleLogger = createTokenContext(empresa_id);
            
            try {
                scheduleLogger.info('Executando renovação agendada', {
                    scheduledFor: renewalAt.toISOString(),
                    actualTime: new Date().toISOString()
                });
                await this._renewToken(empresa_id, refresh_token);
            } catch (error) {
                logError(error, 'scheduledRenewal', { empresa_id });
                
                // Remove da lista se falhou
                this.clearRenewal(empresa_id);
            }
        }, renewalTime);

        this.renewalIntervals.set(empresa_id, intervalId);
        
        // 🐛 DEBUG: Log final do agendamento
        logger.debug('Renovação agendada com sucesso', {
            operation: 'scheduleRenewal',
            intervalId: intervalId.toString().substring(0, 10) + '...',
            activeRenewals: this.renewalIntervals.size
        });
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Salva token no banco com validação
     */
    async _saveTokenToDB(empresa_id, access_token, refresh_token, expires_at) {
        const logger = createTokenContext(empresa_id);
        
        try {
            // 🐛 DEBUG: Log antes de salvar
            logger.debug('Salvando token no banco', {
                operation: 'saveTokenToDB',
                expiresAt: expires_at.toISOString(),
                tokenPreview: `${access_token.substring(0, 8)}***`
            });
            
            const { data, error } = await supabase.from("bling_tokens").upsert(
                {
                    empresa_id,
                    access_token,
                    refresh_token,
                    expires_at: expires_at.toISOString(),
                    updated_at: new Date().toISOString()
                },
                { 
                    onConflict: ["empresa_id"],
                    returning: "minimal" // ✅ Para confirmar que foi salvo
                }
            );

            if (error) throw error;
            
            // ✅ VALIDAÇÃO: Confirma que foi salvo lendo de volta
            const savedToken = await this._getTokenFromDB(empresa_id);
            if (!savedToken || savedToken.expires_at !== expires_at.toISOString()) {
                throw new Error(`Token não foi salvo corretamente. Expected: ${expires_at.toISOString()}, Got: ${savedToken?.expires_at}`);
            }
            
            logger.debug('Token salvo e validado no banco', {
                operation: 'saveTokenToDB',
                expiresAt: expires_at.toISOString(),
                validated: true
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
        this.renewalMutex.clear(); // ✅ Também limpa mutex
        
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
     * ✅ FUNÇÃO ATUALIZADA: Atualiza estatísticas do token manager
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
     * ✅ FUNÇÃO ATUALIZADA: Obtém estatísticas do token manager
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
        const hasTimeouts = this.stats.mutexTimeouts > 0;
        
        return {
            status: recentFailures || hasTimeouts ? 'warning' : 'healthy',
            stats,
            issues: {
                recentFailures,
                hasTimeouts,
                pendingMutex: this.renewalMutex.size > 0
            },
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