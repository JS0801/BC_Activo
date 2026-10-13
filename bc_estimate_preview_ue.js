/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define(['N/ui/serverWidget', 'N/runtime', 'N/url', 'N/log', './bc_estimate_preview_lib'],
    (ui, runtime, url, log, lib) => {
        function beforeLoad(ctx) {
            if (runtime.executionContext !== runtime.ContextType.USER_INTERFACE) return;
            if (!['create', 'copy', 'edit', 'view'].includes(ctx.type)) return;
            const form = ctx.form;
            // Never silently replace another form-attached client module.
            if (form.clientScriptModulePath || Number(form.clientScriptFileId) > 0) {
                log.error('Preview not attached', 'Another form client script is attached. Merge client entry points before enabling preview.');
                return;
            }
            const seed = {};
            lib.BODY.forEach(fieldId => {
                try {
                    const v = ctx.newRecord.getValue({ fieldId });
                    seed[fieldId] = fieldId === 'entity' ? (ctx.newRecord.getText({ fieldId }) || v) : v;
                } catch (_) { /* Absent optional custom fields are handled by the schema. */ }
            });
            const settings = {
                mode: ctx.type, seed,
                id: ['edit', 'view'].includes(ctx.type) ? String(ctx.newRecord.id || '') : '',
                endpoint: url.resolveScript({ scriptId: lib.SCRIPT, deploymentId: lib.DEPLOYMENT, returnExternalUrl: false })
            };
            const configField = form.addField({ id: 'custpage_bc_preview_config', type: ui.FieldType.LONGTEXT, label: 'Preview configuration' });
            configField.defaultValue = JSON.stringify(settings);
            configField.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
            form.clientScriptModulePath = './bc_estimate_preview_cs.js';
            form.addButton({ id: 'custpage_bc_preview_open', label: 'Preview PDF', functionName: 'openPreview' });
        }
        return { beforeLoad };
    });
