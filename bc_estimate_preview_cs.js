/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 * Data access uses N/currentRecord. DOM code is confined to the preview panel
 * and the native page width; that layout integration is not an Oracle-supported UI API.
 */
define(['N/currentRecord', 'N/ui/dialog', './bc_estimate_preview_lib'], (currentRecord, dialog, lib) => {
    let settings, rec, panel, frame, status, auto, timer, objectURL;
    let revision = 0, busy = false, queued = false, shown = false, lineDirty = false;
    let previousBodyClass = false;
    function initialize() {
        if (settings) return;
        rec = currentRecord.get();
        const raw = rec.getValue({ fieldId: 'custpage_bc_preview_config' });
        if (!raw) throw Error('Preview configuration is missing. Check the User Event deployment.');
        settings = JSON.parse(raw);
        const endpoint = new URL(settings.endpoint, window.location.origin);
        if (endpoint.origin !== window.location.origin) throw Error('Preview endpoint must be in this NetSuite account.');
        settings.endpoint = endpoint.href;
    }
    function message(text, error) {
        if (!status) return;
        status.textContent = text;
        status.style.color = error ? '#a32727' : '#465568';
    }
    function value(fieldId) {
        let field;
        try { field = rec.getField({ fieldId }); } catch (_) { field = null; }
        if (!field) return lib.has(settings.seed, fieldId) ? settings.seed[fieldId] : '';
        const v = rec.getValue({ fieldId });
        if (fieldId === 'entity') {
            try { return rec.getText({ fieldId }) || v; } catch (_) { return v; }
        }
        return v;
    }
    function snapshot() {
        const body = {};
        lib.BODY.forEach(k => { body[k] = value(k); });
        const items = [], count = rec.getLineCount({ sublistId: 'item' });
        if (count > lib.MAX_LINES) throw Error('Preview supports up to ' + lib.MAX_LINES + ' item lines.');
        for (let i = 0; i < count; i++) {
            const line = {};
            lib.LINE.forEach(fieldId => {
                const options = { sublistId: 'item', fieldId, line: i };
                if (fieldId === 'item' || fieldId === 'custcol_cpq_subsection') {
                    try { line[fieldId] = rec.getSublistText(options); } catch (_) { /* Free-form text column. */ }
                }
                if (line[fieldId] == null || line[fieldId] === '') {
                    try { line[fieldId] = rec.getSublistValue(options); }
                    catch (e) {
                        if (fieldId !== 'custcol_cpq_subsection') throw Error('Cannot read ' + fieldId + ' on line ' + (i + 1));
                        line[fieldId] = '';
                    }
                }
            });
            items.push(line);
        }
        const result = { version: 1, mode: settings.mode, id: settings.id, body, items,
            entityId: rec.getValue({ fieldId: 'entity' }) };
        lib.validate(result);
        const json = JSON.stringify(result);
        if (json.length > lib.MAX_BODY) throw Error('Preview data exceeds the 2 MB limit.');
        return json;
    }
    function schedule() {
        revision++;
        if (!shown) return;
        message('Changes pending. The displayed PDF may be out of date.');
        clearTimeout(timer);
        if (auto.checked && !lineDirty) timer = setTimeout(refresh, 1000);
    }
    async function refresh() {
        clearTimeout(timer);
        if (!shown) return;
        if (lineDirty) { message('Click Add/Done to validate the item line, or cancel the line edit, then refresh.'); return; }
        if (busy) { queued = true; return; }
        const version = revision;
        let abortTimer;
        try {
            const payload = snapshot();
            busy = true;
            message('Generating PDF from current form values…');
            const controller = new AbortController();
            abortTimer = setTimeout(() => controller.abort(), 90000);
            const response = await fetch(settings.endpoint, {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/pdf, application/json' },
                body: payload, signal: controller.signal
            });
            if (!response.ok) throw Error('Preview request failed (' + response.status + ').');
            const type = response.headers.get('content-type') || '';
            if (!type.toLowerCase().includes('application/pdf')) {
                if (type.toLowerCase().includes('application/json')) {
                    const result = await response.json();
                    throw Error(result.message || 'Preview generation failed.');
                }
                throw Error('NetSuite returned a login or error page. Check your session and Suitelet deployment.');
            }
            const blob = await response.blob();
            if (!shown || version !== revision || lineDirty) {
                queued = shown && auto.checked && !lineDirty;
                message('Changes pending. Refreshing with the latest values…');
                return;
            }
            const next = URL.createObjectURL(blob), old = objectURL;
            objectURL = next;
            frame.src = next + '#view=FitH';
            if (old) URL.revokeObjectURL(old);
            message('Updated ' + new Date().toLocaleTimeString() + ' · Unsaved preview');
        } catch (e) {
            message(e.name === 'AbortError' ? 'Preview timed out. Try Refresh PDF again.' : e.message, true);
        } finally {
            clearTimeout(abortTimer);
            busy = false;
            if (queued && shown && !lineDirty) { queued = false; clearTimeout(timer); timer = setTimeout(refresh, 1000); }
        }
    }
    function closePreview() {
        shown = false;
        revision++;
        queued = false;
        clearTimeout(timer);
        if (panel) panel.hidden = true;
        if (!previousBodyClass) document.body.classList.remove('bc-estimate-preview-open');
        if (frame) frame.src = 'about:blank';
        if (objectURL) URL.revokeObjectURL(objectURL);
        objectURL = null;
    }
    function createPanel() {
        const style = document.createElement('style');
        style.textContent = `
body.bc-estimate-preview-open { width:56vw !important; min-width:0 !important; box-sizing:border-box !important; }
body.bc-estimate-preview-open #div__body { max-width:100%; overflow-x:auto; }
#bc-estimate-preview { position:fixed; right:0; top:0; bottom:0; width:44vw; z-index:10000; background:#f2f4f7; border-left:1px solid #bbc4cf; box-shadow:-3px 0 14px #0002; display:flex; flex-direction:column; font:13px Arial,sans-serif; color:#223147; }
#bc-estimate-preview[hidden] { display:none; }
#bc-estimate-preview .bc-toolbar { padding:14px; background:white; border-bottom:1px solid #d9dfe7; }
#bc-estimate-preview h2 { font:600 17px Arial,sans-serif; margin:0 0 12px; }
#bc-estimate-preview .bc-controls { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
#bc-estimate-preview button { border:1px solid #9daabd; border-radius:4px; padding:7px 10px; background:white; color:#223147; cursor:pointer; }
#bc-estimate-preview button.bc-refresh { background:#245b89; color:white; border-color:#245b89; }
#bc-estimate-preview .bc-status { padding:10px 14px; min-height:32px; line-height:1.4; }
#bc-estimate-preview iframe { width:100%; flex:1; min-height:0; border:0; background:#dfe3e8; }
@media print { #bc-estimate-preview { display:none !important; } body.bc-estimate-preview-open { width:auto !important; } }
`;
        document.head.appendChild(style);
        panel = document.createElement('aside');
        panel.id = 'bc-estimate-preview';
        panel.setAttribute('aria-label', 'Estimate PDF preview');
        // All markup is static; record values are never injected into HTML.
        panel.innerHTML = '<div class="bc-toolbar"><h2>Estimate PDF preview</h2><div class="bc-controls">' +
            '<button type="button" class="bc-refresh">Refresh PDF</button><label><input type="checkbox" checked> Auto refresh</label>' +
            '<button type="button" class="bc-close">Close preview</button></div></div>' +
            '<div class="bc-status" role="status" aria-live="polite"></div><iframe title="Estimate PDF preview" src="about:blank"></iframe>';
        document.body.appendChild(panel);
        frame = panel.querySelector('iframe');
        status = panel.querySelector('.bc-status');
        auto = panel.querySelector('input');
        panel.querySelector('.bc-refresh').addEventListener('click', () => { revision++; refresh(); });
        panel.querySelector('.bc-close').addEventListener('click', closePreview);
        auto.addEventListener('change', () => { clearTimeout(timer); if (auto.checked) schedule(); });
        window.addEventListener('pagehide', closePreview);
    }
    function openPreview() {
        try {
            initialize();
            if (!panel) createPanel();
            if (!shown) previousBodyClass = document.body.classList.contains('bc-estimate-preview-open');
            shown = true;
            panel.hidden = false;
            document.body.classList.add('bc-estimate-preview-open');
            revision++;
            refresh();
        } catch (e) { dialog.alert({ title: 'Estimate PDF preview', message: e.message }); }
    }
    function pageInit() { initialize(); }
    function fieldChanged(ctx) {
        if (ctx.sublistId === 'item') { lineDirty = true; revision++; message('Item changes pending. Click Add/Done to update the preview.'); }
        else if (!ctx.sublistId && !ctx.fieldId.startsWith('custpage_bc_preview')) schedule();
    }
    function postSourcing(ctx) { if (!ctx.sublistId) schedule(); }
    function validateLine() {
        // Never change native validation. sublistChanged confirms successful commit.
        return true;
    }
    function sublistChanged(ctx) {
        if (ctx.sublistId === 'item') { lineDirty = false; schedule(); }
    }
    function lineInit(ctx) {
        if (ctx.sublistId === 'item' && lineDirty) { lineDirty = false; schedule(); }
    }
    return { pageInit, fieldChanged, postSourcing, validateLine, sublistChanged, lineInit, openPreview };
});
