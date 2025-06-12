// src/services/blingTokenService.js - CORREÇÃO PARA ERRO "eq is not a function"
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

// ===========================
// CONSTANTES DE CONFIGURAÇÃO
// ===========================
const MUTEX_TIMEOUT = 30000; // 30 segundos
const DATE_COMPARISON_TOLERANCE = 5000; // 5 segundos de tolerância para timezone
const RENEWAL_GRACE_PERIOD = 60000; // 1 minuto mínimo para próxima renovação

class TokenManager {
    constructor() {
        this.renewalIntervals = new Map();
        this.renewalMutex = new Map(); // Previne renovações concorrentes
        this.mutexTimers = new Map(); // Timers para limpar mutex travados
        
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
            mutexTimeouts: 0,
            mutexClears: 0,
            autoCleanups: 0
        };

        // Logger contexto para tokens
        this.logger = createTokenContext('system');
        
        this.logger.info('Token Manager inicializado', {
            renewalInterval: `${this.TOKEN_RENEWAL_INTERVAL}ms`,
            expirationBuffer: `${this.TOKEN_EXPIRATION_BUFFER}ms`,
            timeout: `${this.REQUEST_TIMEOUT}ms`,
            mutexTimeout: `${MUTEX_TIMEOUT}ms`
        });

        // ✅ CORREÇÃO: Verifica conexão Supabase na inicialização
        this._validateSupabaseConnection();

        // Inicia limpeza automática de mutex travados
        this._startMutexCleanupTimer();
    }

    /**
     * ✅ FUNÇÃO CORRIGIDA: Valida conexão com Supabase na inicialização  
     */
    async _validateSupabaseConnection() {
        try {
            const healthCheck = await supabase.healthCheck();
            
            if (!healthCheck.healthy) {
                this.logger.error('❌ Falha na conexão inicial com Supabase', {
                    operation: 'validateSupabaseConnection',
                    error: healthCheck.error,
                    details: healthCheck.details || 'N/A',
                    hint: healthCheck.hint || 'N/A'
                });
            } else {
                this.logger.info('✅ Conexão com Supabase validada', {
                    operation: 'validateSupabaseConnection'
                });
            }
        } catch (error) {
            this.logger.error('❌ Erro crítico na validação do Supabase', {
                operation: 'validateSupabaseConnection',
                error: error.message
            });
        }
    }

    /**
     * ✅ FUNÇÃO PRINCIPAL CORRIGIDA: Obtém token válido com controle robusto de concorrência
     */
    async getValidToken(empresa_id, accessToken = null, refresh_token = null) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        logger.debug('getValidToken chamado', {
            operation: 'getValidToken',
            hasAccessToken: !!accessToken,
            hasRefreshToken: !!refresh_token,
            mutexExists: this.renewalMutex.has(key),
            activeRenewals: this.renewalIntervals.size
        });
        
        // ✅ PROTEÇÃO MELHORADA: Timeout para mutex travado
        if (this.renewalMutex.has(key)) {
            logger.info('Aguardando renovação em progresso', {
                operation: 'getValidToken',
                status: 'waiting'
            });
            
            try {
                const mutexPromise = this.renewalMutex.get(key);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Mutex timeout - possível deadlock')), MUTEX_TIMEOUT);
                });
                
                await Promise.race([mutexPromise, timeoutPromise]);
                
                // ✅ PÓS-MUTEX: Busca token atualizado do banco
                const updatedToken = await this._getTokenFromDB(empresa_id);
                if (updatedToken?.access_token && this._isTokenValid(updatedToken)) {
                    logger.debug('Token válido obtido após aguardar mutex', {
                        operation: 'getValidToken',
                        tokenPreview: `${updatedToken.access_token.substring(0, 8)}***`
                    });
                    
                    this._ensureRenewalScheduled(empresa_id, updatedToken);
                    return updatedToken.access_token;
                }
                
            } catch (error) {
                logger.warn('Mutex timeout ou erro, removendo mutex travado', {
                    operation: 'getValidToken',
                    error: error.message,
                    mutexKey: key
                });
                
                this._clearMutex(key);
                this.stats.mutexTimeouts++;
            }
        }

        try {
            const tokenData = await this._getTokenFromDB(empresa_id);
            
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

            // ✅ VALIDAÇÃO MELHORADA: Verifica se token é válido
            if (!this._isTokenValid(tokenData)) {
                const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
                const minutesUntilExpiry = Math.round(timeUntilExpiry / 1000 / 60);
                
                logger.info('Token próximo do vencimento, renovando', {
                    operation: 'getValidToken',
                    minutesUntilExpiry,
                    expiresAt: tokenData.expires_at
                });
                
                return await this._renewToken(empresa_id, tokenData.refresh_token);
            }

            // ✅ AGENDAMENTO: Garante que renovação está agendada
            this._ensureRenewalScheduled(empresa_id, tokenData);
            
            const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
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
     * ✅ FUNÇÃO COMPLETAMENTE CORRIGIDA: Busca token com validação robusta do Supabase
     */
    async _getTokenFromDB(empresa_id) {
        const logger = createTokenContext(empresa_id);
        
        try {
            // ✅ VALIDAÇÃO PRÉVIA: Verifica se Supabase está disponível
            if (!supabase) {
                throw new Error('Cliente Supabase não está disponível');
            }

            // ✅ CORREÇÃO CRÍTICA: Usa o Supabase corrigido que retorna QueryBuilder
            const { data, error } = await supabase
                .from("bling_tokens")
                .select("access_token, refresh_token, expires_at")
                .eq("empresa_id", empresa_id)
                .maybeSingle();

            if (error) {
                // ✅ LOG DETALHADO PARA TROUBLESHOOTING
                logger.error('Erro detalhado do Supabase ao buscar token', {
                    operation: 'getTokenFromDB',
                    supabaseError: {
                        message: error.message,
                        details: error.details || 'N/A',
                        hint: error.hint || 'N/A',
                        code: error.code || 'N/A'
                    },
                    empresa_id,
                    hasSupabaseClient: !!supabase
                });
                throw error;
            }
            
            // ✅ NORMALIZAÇÃO AUTOMÁTICA: Garante formato ISO consistente
            if (data && data.expires_at) {
                try {
                    // Converte qualquer formato de data para ISO string padrão
                    const normalizedDate = new Date(data.expires_at).toISOString();
                    data.expires_at = normalizedDate;
                } catch (dateError) {
                    logger.warn('Erro ao normalizar data do token', {
                        operation: 'getTokenFromDB',
                        originalDate: data.expires_at,
                        error: dateError.message
                    });
                    // Se não conseguir normalizar, mantém o original
                }
            }
            
            logger.debug('Token recuperado e normalizado', {
                operation: 'getTokenFromDB',
                hasToken: !!data,
                expiresAt: data?.expires_at
            });
            
            return data;
        } catch (error) {
            // ✅ LOG DETALHADO PARA TROUBLESHOOTING
            logger.error('Erro crítico ao buscar token no banco', {
                operation: 'getTokenFromDB',
                error: error.message,
                errorCode: error.code || 'N/A',
                errorDetails: error.details || 'N/A',
                errorHint: error.hint || 'N/A',
                empresa_id,
                hasSupabaseClient: !!supabase
            });

            logError(error, 'getTokenFromDB', { 
                empresa_id,
                supabaseAvailable: !!supabase
            });
            throw error;
        }
    }

    /**
     * ✅ FUNÇÃO COMPLETAMENTE CORRIGIDA: Salva token com validação do Supabase
     */
    async _saveTokenToDB(empresa_id, access_token, refresh_token, expires_at) {
        const logger = createTokenContext(empresa_id);
        
        try {
            // ✅ VALIDAÇÃO PRÉVIA: Verifica se Supabase está disponível
            if (!supabase) {
                throw new Error('Cliente Supabase não está disponível');
            }

            // ✅ NORMALIZAÇÃO: Converte para timestamp UTC consistente
            const normalizedExpiresAt = new Date(expires_at).toISOString();
            
            logger.debug('Salvando token no banco', {
                operation: 'saveTokenToDB',
                expiresAt: normalizedExpiresAt,
                tokenPreview: `${access_token.substring(0, 8)}***`
            });
            
            // ✅ CORREÇÃO CRÍTICA: Usa o Supabase corrigido
            const { data, error } = await supabase.from("bling_tokens").upsert(
                {
                    empresa_id,
                    access_token,
                    refresh_token,
                    expires_at: normalizedExpiresAt,
                    updated_at: new Date().toISOString()
                },
                { 
                    onConflict: ["empresa_id"],
                    returning: "minimal"
                }
            );

            if (error) {
                logger.error('Erro detalhado do Supabase ao salvar token', {
                    operation: 'saveTokenToDB',
                    supabaseError: {
                        message: error.message,
                        details: error.details || 'N/A',
                        hint: error.hint || 'N/A',
                        code: error.code || 'N/A'
                    },
                    empresa_id,
                    hasSupabaseClient: !!supabase
                });
                throw error;
            }
            
            // ✅ VALIDAÇÃO MELHORADA: Compara timestamps numericamente
            const savedToken = await this._getTokenFromDB(empresa_id);
            if (!savedToken) {
                throw new Error('Token não foi encontrado após salvamento');
            }
            
            // ✅ COMPARAÇÃO ROBUSTA: Converte ambas as datas para timestamp
            const expectedTime = new Date(expires_at).getTime();
            const savedTime = new Date(savedToken.expires_at).getTime();
            const timeDiff = Math.abs(expectedTime - savedTime);
            
            // ✅ TOLERÂNCIA AUMENTADA: Aceita diferenças menores que 5 segundos
            if (timeDiff > DATE_COMPARISON_TOLERANCE) {
                throw new Error(`Token timestamp inválido: diferença de ${timeDiff}ms excede tolerância de ${DATE_COMPARISON_TOLERANCE}ms`);
            }
            
            logger.debug('Token salvo e validado com sucesso', {
                operation: 'saveTokenToDB',
                expectedTime: new Date(expectedTime).toISOString(),
                savedTime: new Date(savedTime).toISOString(),
                timeDifference: `${timeDiff}ms`,
                validated: true
            });
            
        } catch (error) {
            // ✅ LOG DETALHADO PARA TROUBLESHOOTING
            logger.error('Erro crítico ao salvar token no banco', {
                operation: 'saveTokenToDB',
                error: error.message,
                errorCode: error.code || 'N/A',
                errorDetails: error.details || 'N/A',
                errorHint: error.hint || 'N/A',
                empresa_id,
                hasSupabaseClient: !!supabase,
                expiresAt: expires_at?.toISOString?.() || expires_at
            });

            logError(error, 'saveTokenToDB', { 
                empresa_id,
                expiresAt: expires_at?.toISOString?.() || expires_at,
                supabaseAvailable: !!supabase
            });
            throw error;
        }
    }

    /**
     * ✅ RESTO DAS FUNÇÕES - Mantendo as implementações originais corretas
     */
    _isTokenValid(tokenData) {
        if (!tokenData?.expires_at) {
            return false;
        }
        
        try {
            const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
            const isValid = timeUntilExpiry > this.TOKEN_EXPIRATION_BUFFER;
            
            if (!isValid) {
                const logger = createTokenContext('system');
                logger.debug('Token inválido detectado', {
                    operation: 'isTokenValid',
                    expiresAt: tokenData.expires_at,
                    timeUntilExpiry: `${Math.round(timeUntilExpiry / 1000)}s`,
                    bufferRequired: `${Math.round(this.TOKEN_EXPIRATION_BUFFER / 1000)}s`
                });
            }
            
            return isValid;
        } catch (error) {
            const logger = createTokenContext('system');
            logger.warn('Erro na validação de token', {
                operation: 'isTokenValid',
                error: error.message,
                expiresAt: tokenData.expires_at
            });
            return false;
        }
    }

    _getTimeUntilExpiry(expiresAt) {
        try {
            const expirationDate = new Date(expiresAt);
            
            if (isNaN(expirationDate.getTime())) {
                throw new Error(`Data de expiração inválida: ${expiresAt}`);
            }
            
            const timeUntilExpiry = expirationDate.getTime() - Date.now();
            return timeUntilExpiry;
        } catch (error) {
            const logger = createTokenContext('system');
            logger.error('Erro ao calcular tempo até expiração', {
                operation: 'getTimeUntilExpiry',
                expiresAt,
                error: error.message
            });
            throw error;
        }
    }

    _ensureRenewalScheduled(empresa_id, tokenData) {
        if (!this.renewalIntervals.has(empresa_id)) {
            try {
                const timeUntilExpiry = this._getTimeUntilExpiry(tokenData.expires_at);
                
                if (timeUntilExpiry > this.TOKEN_EXPIRATION_BUFFER) {
                    this._scheduleRenewal(empresa_id, tokenData.refresh_token, timeUntilExpiry);
                }
            } catch (error) {
                const logger = createTokenContext(empresa_id);
                logger.warn('Erro ao agendar renovação', {
                    operation: 'ensureRenewalScheduled',
                    error: error.message
                });
            }
        }
    }

    async _renewToken(empresa_id, refresh_token) {
        const key = `empresa_${empresa_id}`;
        const logger = createTokenContext(empresa_id);
        
        if (this.renewalMutex.has(key)) {
            try {
                const mutexPromise = this.renewalMutex.get(key);
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Renewal mutex timeout')), MUTEX_TIMEOUT);
                });
                
                const result = await Promise.race([mutexPromise, timeoutPromise]);
                return result.access_token;
                
            } catch (error) {
                logger.warn('Timeout em mutex de renovação, removendo', {
                    operation: 'renewToken',
                    error: error.message
                });
                
                this._clearMutex(key);
                this.stats.mutexTimeouts++;
            }
        }

        const renewalPromise = this._performRenewal(empresa_id, refresh_token);
        this._setMutex(key, renewalPromise);
        
        rateLimiterManager.startTokenRenewal(empresa_id, renewalPromise);

        try {
            const result = await renewalPromise;
            return result.access_token;
        } catch (error) {
            logger.error('Erro na renovação de token', {
                operation: 'renewToken',
                error: error.message
            });
            throw error;
        } finally {
            this._clearMutex(key);
            this.stats.mutexClears++;
        }
    }

    async _performRenewal(empresa_id, refresh_token) {
        const logger = createTokenContext(empresa_id);
        const startTime = Date.now();
        
        logOperationStart('tokenRenewal', { 
            empresa_id,
            refreshTokenPreview: refresh_token ? `${refresh_token.substring(0, 8)}***` : null
        });

        try {
            await waitForToken(empresa_id);
            
            logger.info('Iniciando renovação de token', {
                operation: 'performRenewal'
            });

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

            await this._saveTokenToDB(empresa_id, access_token, new_refresh_token, expires_at);

            const timeUntilExpiry = expires_at.getTime() - Date.now();
            this._scheduleRenewal(empresa_id, new_refresh_token, timeUntilExpiry);

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

            return tokenResult;

        } catch (error) {
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

    _scheduleRenewal(empresa_id, refresh_token, timeUntilExpiry) {
        const logger = createTokenContext(empresa_id);
        
        if (!timeUntilExpiry || timeUntilExpiry <= 0 || !isFinite(timeUntilExpiry)) {
            logger.error('timeUntilExpiry inválido, não agendando renovação', {
                operation: 'scheduleRenewal',
                timeUntilExpiry
            });
            return;
        }
        
        this.clearRenewal(empresa_id);

        const renewalTime = Math.max(
            timeUntilExpiry - this.TOKEN_EXPIRATION_BUFFER, 
            RENEWAL_GRACE_PERIOD
        );
        
        logger.info('Agendando renovação automática', {
            operation: 'scheduleRenewal',
            renewalInMinutes: Math.round(renewalTime / 1000 / 60)
        });
        
        const intervalId = setTimeout(async () => {
            try {
                await this._renewToken(empresa_id, refresh_token);
            } catch (error) {
                logError(error, 'scheduledRenewal', { empresa_id });
                this.clearRenewal(empresa_id);
            }
        }, renewalTime);

        this.renewalIntervals.set(empresa_id, intervalId);
    }

    _setMutex(key, promise) {
        this.renewalMutex.set(key, promise);
        
        const timer = setTimeout(() => {
            if (this.renewalMutex.has(key)) {
                this.logger.warn('Limpando mutex travado automaticamente', { 
                    key,
                    timeoutMs: MUTEX_TIMEOUT * 2 
                });
                this._clearMutex(key);
                this.stats.autoCleanups++;
            }
        }, MUTEX_TIMEOUT * 2);
        
        timer.created = Date.now();
        this.mutexTimers.set(key, timer);
    }

    _clearMutex(key) {
        this.renewalMutex.delete(key);
        
        if (this.mutexTimers.has(key)) {
            clearTimeout(this.mutexTimers.get(key));
            this.mutexTimers.delete(key);
        }
    }

    _startMutexCleanupTimer() {
        setInterval(() => {
            const now = Date.now();
            let cleanedMutex = 0;
            
            for (const [key, timer] of this.mutexTimers.entries()) {
                const timerAge = timer.created ? (now - timer.created) : 0;
                
                if (timerAge > 300000) { // 5 minutos
                    this.logger.warn('Limpeza automática de mutex muito antigo', { 
                        key,
                        timerAge: `${Math.round(timerAge / 1000)}s`
                    });
                    this._clearMutex(key);
                    cleanedMutex++;
                }
            }
            
            if (cleanedMutex > 0) {
                this.stats.autoCleanups += cleanedMutex;
            }
        }, 60000);
    }

    _updateStats(success, renewalTime) {
        this.stats.totalRenewals++;
        this.stats.lastRenewalTime = new Date().toISOString();
        
        if (success) {
            this.stats.successfulRenewals++;
        } else {
            this.stats.failedRenewals++;
        }
        
        this.stats.averageRenewalTime = (
            (this.stats.averageRenewalTime * (this.stats.totalRenewals - 1) + renewalTime) / 
            this.stats.totalRenewals
        );
    }

    clearRenewal(empresa_id) {
        const intervalId = this.renewalIntervals.get(empresa_id);
        if (intervalId) {
            clearTimeout(intervalId);
            this.renewalIntervals.delete(empresa_id);
        }
    }

    clearAllRenewals() {
        const totalIntervals = this.renewalIntervals.size;
        const totalMutex = this.renewalMutex.size;
        const totalTimers = this.mutexTimers.size;
        
        this.logger.info('Limpando todos os agendamentos de renovação', {
            operation: 'clearAllRenewals',
            totalIntervals,
            totalMutex,
            totalTimers
        });
        
        for (const [empresa_id, intervalId] of this.renewalIntervals) {
            clearTimeout(intervalId);
        }
        this.renewalIntervals.clear();
        
        this.renewalMutex.clear();
        
        for (const timer of this.mutexTimers.values()) {
            clearTimeout(timer);
        }
        this.mutexTimers.clear();
        
        this.logger.info('Todos os agendamentos removidos', {
            operation: 'clearAllRenewals',
            clearedIntervals: totalIntervals,
            clearedMutex: totalMutex,
            clearedTimers: totalTimers
        });
    }

    getStats() {
        return {
            ...this.stats,
            activeRenewals: this.renewalIntervals.size,
            pendingRenewals: this.renewalMutex.size,
            activeMutexTimers: this.mutexTimers.size,
            successRate: this.stats.totalRenewals > 0 
                ? (this.stats.successfulRenewals / this.stats.totalRenewals * 100).toFixed(2) + '%'
                : '0%',
            averageRenewalTime: Math.round(this.stats.averageRenewalTime) + 'ms'
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
    
    // Novas funcionalidades de monitoramento
    getTokenManagerStats: () => tokenManager.getStats(),
    getTokenManagerHealth: () => tokenManager.getHealthStatus(),
    
    // Acesso à instância (para casos avançados)
    tokenManager,
    
    // Funções utilitárias
    isTokenValid: async (empresa_id) => {
        try {
            const token = await tokenManager._getTokenFromDB(empresa_id);
            return token ? tokenManager._isTokenValid(token) : false;
        } catch (error) {
            return false;
        }
    },
    
    forceTokenRenewal: async (empresa_id, refresh_token) => {
        try {
            const result = await tokenManager._renewToken(empresa_id, refresh_token);
            return { success: true, access_token: result.access_token };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },
    
    getTokenInfo: async (empresa_id) => {
        try {
            const tokenData = await tokenManager._getTokenFromDB(empresa_id);
            if (!tokenData) {
                return { exists: false };
            }
            
            const timeUntilExpiry = tokenManager._getTimeUntilExpiry(tokenData.expires_at);
            const isValid = tokenManager._isTokenValid(tokenData);
            
            return {
                exists: true,
                isValid,
                expiresAt: tokenData.expires_at,
                timeUntilExpiry,
                minutesUntilExpiry: Math.round(timeUntilExpiry / 1000 / 60),
                hasRefreshToken: !!tokenData.refresh_token,
                tokenPreview: tokenData.access_token ? 
                    `${tokenData.access_token.substring(0, 8)}***` : null
            };
        } catch (error) {
            return { exists: false, error: error.message };
        }
    },
    
    testSupabaseConnection: async () => {
        try {
            const healthCheck = await supabase.healthCheck();
            
            if (!healthCheck.healthy) {
                return {
                    success: false,
                    error: healthCheck.error,
                    details: healthCheck.details || 'N/A',
                    hint: healthCheck.hint || 'N/A'
                };
            }
            
            return {
                success: true,
                message: 'Conexão com Supabase OK',
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }
};