// src/services/blingQueueService.js
const supabase = require("./supabaseService");
const { logger } = require("../utils/logger");
const { logEvent } = require("./auditLogService");

// ===========================
// CONFIGURAÇÃO
// ===========================
const TICK_INTERVAL_MS = 5000;          // pollagem a cada 5s
const MAX_JOBS_PER_TICK = 5;            // até 5 jobs por iteração (rate limit Bling cobre o resto)
const STALE_LOCK_MS = 5 * 60 * 1000;    // jobs travados em "processando" há > 5min voltam pra pendente
const STALE_CLEAN_INTERVAL_MS = 60000;  // checa staleness a cada 1min
const BACKOFF_CAP_MS = 5 * 60 * 1000;   // backoff exponencial cap em 5min

// Operações conhecidas. Handlers são registrados via registerHandler() em outros módulos.
const KNOWN_OPERATIONS = [
    'upsert_fornecedor_produto',
    'upsert_produto',
    'criar_produto'
];

class BlingQueueProcessor {
    constructor() {
        this.workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
        this.tickInterval = null;
        this.staleCleanInterval = null;
        this.processing = false;
        this.handlers = {};
        this.stats = {
            processed: 0,
            failures: 0,
            recovered: 0,
            staleCleaned: 0,
            startedAt: null
        };

        logger.info('BlingQueueProcessor inicializado', {
            service: 'bling-queue',
            workerId: this.workerId,
            knownOperations: KNOWN_OPERATIONS
        });
    }

    /**
     * Inicia o tick do worker. Chamado pelo server.js após ouvir a porta.
     */
    start() {
        if (this.tickInterval) {
            logger.warn('start() chamado mas worker já está rodando', { service: 'bling-queue' });
            return;
        }

        this.stats.startedAt = new Date().toISOString();
        this.tickInterval = setInterval(() => this.tick(), TICK_INTERVAL_MS);
        this.staleCleanInterval = setInterval(() => this.clearStaleProcessing(), STALE_CLEAN_INTERVAL_MS);

        logger.info('Worker iniciado', {
            service: 'bling-queue',
            workerId: this.workerId,
            tickIntervalMs: TICK_INTERVAL_MS,
            maxJobsPerTick: MAX_JOBS_PER_TICK
        });

        // Limpa locks órfãos do startup (caso anterior tenha morrido sem terminar)
        setTimeout(() => this.clearStaleProcessing(), 3000);
    }

    /**
     * Para o tick (graceful shutdown).
     */
    stop() {
        if (this.tickInterval) clearInterval(this.tickInterval);
        if (this.staleCleanInterval) clearInterval(this.staleCleanInterval);
        this.tickInterval = null;
        this.staleCleanInterval = null;

        logger.info('Worker parado', {
            service: 'bling-queue',
            workerId: this.workerId,
            stats: this.stats
        });
    }

    /**
     * Registra handler para uma operação. Outros módulos chamam isso para
     * conectar suas implementações sem mexer aqui.
     *
     * @param {string} operacao
     * @param {(job: object, ctx: { workerId: string }) => Promise<any>} handler
     */
    registerHandler(operacao, handler) {
        if (typeof handler !== 'function') {
            throw new Error('handler deve ser função async');
        }
        this.handlers[operacao] = handler;
        logger.info('Handler registrado', { service: 'bling-queue', operacao });
    }

    /**
     * Enfileira um job. Valida que a empresa tem Bling ativo antes —
     * empresas sem `bling_tokens` válidos retornam `{ skipped: true }`.
     */
    async enqueue(empresa_id, operacao, payload = {}, opts = {}) {
        if (!Number.isInteger(empresa_id) || empresa_id <= 0) {
            throw new Error('empresa_id deve ser inteiro positivo');
        }
        if (!KNOWN_OPERATIONS.includes(operacao)) {
            throw new Error(`Operação desconhecida: ${operacao}. Conhecidas: ${KNOWN_OPERATIONS.join(', ')}`);
        }

        const hasBling = await this.empresaTemBlingAtivo(empresa_id);
        if (!hasBling) {
            logger.info('enqueue ignorado: empresa sem Bling ativo', {
                service: 'bling-queue',
                empresa_id,
                operacao
            });
            return { skipped: true, reason: 'sem_bling_ativo', empresa_id };
        }

        const { data, error } = await supabase.from('bling_sync_queue').insert({
            empresa_id,
            operacao,
            payload,
            origem: opts.origem || null,
            origem_ref_id: opts.origem_ref_id || null,
            max_tentativas: opts.max_tentativas || 8
        }).select().single();

        if (error) {
            logger.error('Erro ao enfileirar job', {
                service: 'bling-queue',
                empresa_id,
                operacao,
                error: error.message,
                code: error.code
            });
            await logEvent('error', 'bling_queue_enqueue_failed', {
                empresa_id,
                contexto: { operacao, payload, error: error.message, code: error.code }
            });
            throw error;
        }

        logger.info('Job enfileirado', {
            service: 'bling-queue',
            empresa_id,
            operacao,
            jobId: data.id,
            origem: opts.origem
        });
        return { skipped: false, jobId: data.id };
    }

    /**
     * Verifica se empresa tem token Bling ativo (não revogado).
     */
    async empresaTemBlingAtivo(empresa_id) {
        try {
            const { data, error } = await supabase
                .from('bling_tokens')
                .select('empresa_id, is_revoke')
                .eq('empresa_id', empresa_id)
                .maybeSingle();

            if (error) {
                logger.warn('Erro ao verificar bling_tokens, fail-safe = sem Bling', {
                    service: 'bling-queue',
                    empresa_id,
                    error: error.message
                });
                return false;
            }

            // Tem registro E não está revogado
            return !!data && data.is_revoke !== true;
        } catch (err) {
            logger.warn('Exceção em empresaTemBlingAtivo', {
                service: 'bling-queue',
                empresa_id,
                error: err.message
            });
            return false;
        }
    }

    /**
     * Recupera jobs travados em "processando" há mais que STALE_LOCK_MS,
     * voltando-os para "pendente". Cobre crashes e deploys.
     */
    async clearStaleProcessing() {
        try {
            const cutoff = new Date(Date.now() - STALE_LOCK_MS).toISOString();
            const { data, error } = await supabase
                .from('bling_sync_queue')
                .update({
                    status: 'pendente',
                    locked_by: null,
                    locked_em: null,
                    updated_at: new Date().toISOString()
                })
                .eq('status', 'processando')
                .lt('locked_em', cutoff)
                .select('id, empresa_id, operacao');

            if (error) {
                logger.warn('Erro ao limpar locks travados', {
                    service: 'bling-queue',
                    error: error.message
                });
                return;
            }

            if (data && data.length > 0) {
                this.stats.staleCleaned += data.length;
                logger.warn(`${data.length} jobs travados foram destravados`, {
                    service: 'bling-queue',
                    jobIds: data.map(j => j.id)
                });
            }
        } catch (err) {
            logger.warn('Exceção em clearStaleProcessing', {
                service: 'bling-queue',
                error: err.message
            });
        }
    }

    /**
     * Tick principal — processa até MAX_JOBS_PER_TICK jobs. Idempotente.
     */
    async tick() {
        if (this.processing) return;
        this.processing = true;

        try {
            for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
                const continued = await this.processNext();
                if (!continued) break;
            }
        } catch (err) {
            logger.error('Erro inesperado no tick', {
                service: 'bling-queue',
                workerId: this.workerId,
                error: err.message
            });
        } finally {
            this.processing = false;
        }
    }

    /**
     * Pega o próximo job, faz claim atômico, despacha pro handler.
     * Retorna true se processou (ou tentou processar) — pra continuar o loop.
     * Retorna false se não há mais jobs pendentes.
     */
    async processNext() {
        const { data: candidato, error: candErr } = await supabase
            .from('bling_sync_queue')
            .select('id')
            .eq('status', 'pendente')
            .lte('proximo_em', new Date().toISOString())
            .order('proximo_em', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (candErr) {
            logger.warn('Erro ao buscar próximo job', {
                service: 'bling-queue',
                error: candErr.message
            });
            return false;
        }
        if (!candidato) return false;

        // Claim atômico: UPDATE WHERE id = X AND status = 'pendente'.
        // Se outro worker pegou primeiro, claimed vem null — apenas continua o loop.
        const { data: claimed, error: claimErr } = await supabase
            .from('bling_sync_queue')
            .update({
                status: 'processando',
                locked_by: this.workerId,
                locked_em: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .eq('id', candidato.id)
            .eq('status', 'pendente')
            .select()
            .maybeSingle();

        if (claimErr) {
            logger.warn('Erro ao fazer claim', {
                service: 'bling-queue',
                jobId: candidato.id,
                error: claimErr.message
            });
            return true;
        }
        if (!claimed) {
            // Outro worker venceu a corrida. OK.
            return true;
        }

        try {
            const handler = this.handlers[claimed.operacao];
            if (typeof handler !== 'function') {
                throw Object.assign(new Error(`Handler não registrado para '${claimed.operacao}'`), {
                    code: 'NO_HANDLER'
                });
            }
            await handler(claimed, { workerId: this.workerId });
            await this.handleSuccess(claimed);
        } catch (err) {
            await this.handleFailure(claimed, err);
        }
        return true;
    }

    async handleSuccess(job) {
        await supabase
            .from('bling_sync_queue')
            .update({
                status: 'concluido',
                concluido_em: new Date().toISOString(),
                ultimo_erro: null,
                ultimo_erro_codigo: null,
                locked_by: null,
                locked_em: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', job.id);

        this.stats.processed++;

        if (job.tentativas > 0) {
            this.stats.recovered++;
            await logEvent('info', 'bling_sync_recovered', {
                empresa_id: job.empresa_id,
                contexto: {
                    jobId: job.id,
                    operacao: job.operacao,
                    tentativas: job.tentativas + 1
                }
            });
        }

        logger.info('Job concluído', {
            service: 'bling-queue',
            jobId: job.id,
            operacao: job.operacao,
            empresa_id: job.empresa_id,
            tentativas: job.tentativas + 1
        });
    }

    async handleFailure(job, error) {
        const codigo = this.extractErrorCode(error);
        const mensagem = this.errorMessage(error);
        const isTerminal = this.isTerminal(codigo);
        const novasTentativas = (job.tentativas || 0) + 1;
        const excedeuMax = novasTentativas >= job.max_tentativas;

        if (isTerminal || excedeuMax) {
            await supabase
                .from('bling_sync_queue')
                .update({
                    status: 'erro_terminal',
                    tentativas: novasTentativas,
                    ultimo_erro: mensagem,
                    ultimo_erro_codigo: codigo,
                    locked_by: null,
                    locked_em: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', job.id);

            this.stats.failures++;

            await logEvent('error', 'bling_sync_failed', {
                empresa_id: job.empresa_id,
                contexto: {
                    jobId: job.id,
                    operacao: job.operacao,
                    payload: job.payload,
                    tentativas: novasTentativas,
                    erro: mensagem,
                    codigo,
                    motivo: isTerminal ? 'erro_terminal' : 'max_tentativas_excedidas'
                }
            });

            logger.error('Job falhou (terminal)', {
                service: 'bling-queue',
                jobId: job.id,
                operacao: job.operacao,
                empresa_id: job.empresa_id,
                tentativas: novasTentativas,
                codigo,
                error: mensagem
            });
        } else {
            const delayMs = Math.min(2 ** novasTentativas * 1000, BACKOFF_CAP_MS);
            const proximoEm = new Date(Date.now() + delayMs).toISOString();

            await supabase
                .from('bling_sync_queue')
                .update({
                    status: 'pendente',
                    tentativas: novasTentativas,
                    ultimo_erro: mensagem,
                    ultimo_erro_codigo: codigo,
                    proximo_em: proximoEm,
                    locked_by: null,
                    locked_em: null,
                    updated_at: new Date().toISOString()
                })
                .eq('id', job.id);

            logger.warn('Job falhou (reagendado)', {
                service: 'bling-queue',
                jobId: job.id,
                operacao: job.operacao,
                empresa_id: job.empresa_id,
                tentativas: novasTentativas,
                codigo,
                proximoEm,
                delayMs
            });
        }
    }

    extractErrorCode(error) {
        if (!error) return 'unknown';
        if (error.code === 'NO_HANDLER') return 'NO_HANDLER';
        if (error?.response?.status) return String(error.response.status);
        if (error?.status) return String(error.status);
        if (error?.code) return String(error.code);
        return 'unknown';
    }

    errorMessage(error) {
        if (!error) return 'erro sem detalhes';
        if (typeof error === 'string') return error.slice(0, 1000);
        if (error.message) return error.message.slice(0, 1000);
        try { return JSON.stringify(error).slice(0, 1000); } catch { return 'erro não serializável'; }
    }

    isTerminal(codigo) {
        // 401 e 429 não são terminais (token refresh, rate limit) — tentar de novo
        if (codigo === '401' || codigo === '429') return false;
        // NO_HANDLER não é "terminal de Bling" mas é definitivo
        if (codigo === 'NO_HANDLER') return true;
        const num = parseInt(codigo, 10);
        if (isNaN(num)) return false; // erros não-HTTP retentam
        // 4xx (exceto 401/429) são terminais; 5xx retentam
        return num >= 400 && num < 500;
    }

    getStats() {
        return {
            ...this.stats,
            workerId: this.workerId,
            running: !!this.tickInterval,
            handlersRegistrados: Object.keys(this.handlers)
        };
    }
}

const blingQueueProcessor = new BlingQueueProcessor();

module.exports = {
    blingQueueProcessor,
    BlingQueueProcessor,
    KNOWN_OPERATIONS
};
