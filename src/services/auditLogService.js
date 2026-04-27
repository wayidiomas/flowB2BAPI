// src/services/auditLogService.js
const supabase = require("./supabaseService");
const { logger } = require("../utils/logger");

const VALID_SEVERITIES = ['info', 'warn', 'error', 'critical'];

/**
 * Grava um evento no audit_log para o painel de auditoria do superadmin.
 * Nunca propaga erro — falha no audit log não pode derrubar o caller.
 *
 * @param {('info'|'warn'|'error'|'critical')} severity
 * @param {string} evento - identificador do evento. Ex: 'bling_sync_failed', 'token_revoked'
 * @param {object} [opts]
 * @param {number} [opts.empresa_id]
 * @param {number} [opts.user_id]
 * @param {object} [opts.contexto] - payload livre (stack, request_id, queue_job_id, etc)
 */
async function logEvent(severity, evento, opts = {}) {
    if (!VALID_SEVERITIES.includes(severity)) {
        logger.warn('audit_log: severity inválida, defaulting para "warn"', {
            service: 'audit-log',
            severityRecebida: severity,
            evento
        });
        severity = 'warn';
    }

    if (!evento || typeof evento !== 'string') {
        logger.warn('audit_log: evento ausente ou inválido, ignorando', {
            service: 'audit-log',
            evento
        });
        return null;
    }

    try {
        const { data, error } = await supabase.from('audit_log').insert({
            severity,
            evento,
            empresa_id: opts.empresa_id || null,
            user_id: opts.user_id || null,
            contexto: opts.contexto || {}
        }).select().single();

        if (error) {
            logger.error('audit_log: falha ao gravar evento', {
                service: 'audit-log',
                evento,
                severity,
                error: error.message,
                code: error.code
            });
            return null;
        }

        logger.debug('audit_log: evento gravado', {
            service: 'audit-log',
            evento,
            severity,
            empresa_id: opts.empresa_id,
            audit_id: data?.id
        });

        return data;
    } catch (err) {
        // Ultima rede de proteção — nunca explode o caller
        logger.error('audit_log: exceção inesperada', {
            service: 'audit-log',
            evento,
            error: err.message
        });
        return null;
    }
}

/**
 * Marca um evento como resolvido. Usado pelo painel do superadmin.
 *
 * @param {number} auditId
 * @param {object} [opts]
 * @param {number} [opts.user_id] - quem resolveu
 * @param {string} [opts.nota]
 */
async function resolverEvento(auditId, opts = {}) {
    try {
        const { data, error } = await supabase
            .from('audit_log')
            .update({
                resolvido: true,
                resolvido_em: new Date().toISOString(),
                resolvido_por: opts.user_id || null,
                resolvido_nota: opts.nota || null
            })
            .eq('id', auditId)
            .select()
            .single();

        if (error) {
            logger.error('audit_log: falha ao resolver evento', {
                service: 'audit-log',
                auditId,
                error: error.message
            });
            return null;
        }

        return data;
    } catch (err) {
        logger.error('audit_log: exceção ao resolver evento', {
            service: 'audit-log',
            auditId,
            error: err.message
        });
        return null;
    }
}

module.exports = {
    logEvent,
    resolverEvento,
    VALID_SEVERITIES
};
