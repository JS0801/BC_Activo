/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/render', 'N/record', 'N/runtime', 'N/config', 'N/file', 'N/url', 'N/xml', 'N/format/i18n', 'N/log', './bc_estimate_preview_lib'],
    (render, record, runtime, config, file, url, xml, i18n, log, lib) => {
        function read(rec, fieldId) { return rec.getValue({ fieldId }); }
        function mediaURL(value, pdfOnly) {
            const input = String(value).trim().replace(/&amp;/g, '&');
            let id = /^\d+$/.test(input) ? input : '';
            if (!id) {
                const host = url.resolveDomain({ hostType: url.HostType.APPLICATION });
                const match = input.match(/^(?:https:\/\/([^/]+))?(\/core\/media\/media\.nl)\?([^#]+)$/i);
                if (!match || (match[1] && match[1].toLowerCase() !== host.toLowerCase())) throw Error('Supporting files must be File Cabinet files in this NetSuite account.');
                const idMatch = match[3].match(/(?:^|&)id=(\d+)(?:&|$)/);
                if (!idMatch) throw Error('Supporting file URL has no valid file ID.');
                id = idMatch[1];
            }
            const f = file.load({ id: Number(id) }); // Uses the current role, never an elevated role.
            if (pdfOnly && f.fileType !== file.Type.PDF) throw Error('Supporting file ' + id + ' is not a PDF.');
            const path = f.url;
            if (/^\/\//.test(path)) return 'https:' + path;
            return /^https:\/\//i.test(path) ? path : 'https://' + url.resolveDomain({ hostType: url.HostType.APPLICATION }) + path;
        }
        function rich(input, name) {
            if (!input) return '';
            let text = input.replace(/&nbsp;/gi, '&#160;').replace(/<br\s*\/?\s*>/gi, '<br />')
                .replace(/<hr\s*\/?\s*>/gi, '<hr />').replace(/&(?!#\d+;|#x[\da-f]+;|amp;|lt;|gt;|quot;|apos;)/gi, '&amp;');
            // Reject renderer directives/active markup; data is never evaluated as FreeMarker.
            if (/<!|<\?|<\/?(?:script|iframe|object|embed|link|pdf|pdfset|head|body|macro|pbr|style)\b|\son\w+\s*=|(?:javascript|data|file):|url\s*\(|expression\s*\(|@import/i.test(text)) {
                throw Error('Unsupported markup in ' + name + '. Remove embedded scripts, page directives, or external resources.');
            }
            text = text.replace(/<img\b([^>]*?)\/?\s*>/gi, (_, attrs) => {
                const src = attrs.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
                if (!src) throw Error('An image in ' + name + ' has no quoted source.');
                const replaced = attrs.replace(src[0], 'src="' + lib.escape(mediaURL(src[2], false)) + '"');
                return '<img' + replaced.replace(/\/\s*$/, '') + ' />';
            });
            const allowed = ['p','div','span','br','hr','ul','ol','li','b','strong','em','i','u','s','strike','sub','sup','font',
                'h1','h2','h3','h4','h5','h6','img','a','blockquote','pre','code','table','thead','tbody','tfoot','tr','td','th'];
            for (const tag of text.matchAll(/<\/?([a-z][a-z0-9:_-]*)\b/gi)) {
                if (!allowed.includes(tag[1].toLowerCase())) throw Error('Unsupported HTML tag ' + tag[1] + ' in ' + name);
            }
            // No secondary resource attributes are accepted outside the normalized img src.
            if (/\s(?:background|srcset|xlink:href|xmlns|poster)\s*=/i.test(text)) throw Error('Unsupported resource attribute in ' + name);
            try { xml.Parser.fromString({ text: '<root>' + text + '</root>' }); }
            catch (_) { throw Error('Rich text in ' + name + ' is not valid PDF markup. Check its HTML formatting.'); }
            return text;
        }
        function onRequest(ctx) {
            ctx.response.setHeader({ name: 'Cache-Control', value: 'no-store, private' });
            try {
                if (ctx.request.method !== 'POST') throw Error('Open this preview from an Estimate using Preview PDF.');
                const user = runtime.getCurrentUser();
                if (user.id <= 0 || user.getPermission({ name: 'TRAN_ESTIMATE' }) < runtime.Permission.VIEW) throw Error('Estimate permission is required.');
                const body = ctx.request.body || '';
                if (body.length > lib.MAX_BODY) throw Error('Preview data exceeds the 2 MB limit.');
                const payload = lib.validate(JSON.parse(body));
                if (['edit', 'view'].includes(payload.mode) && !payload.id) throw Error('Existing Estimate ID is required.');
                if (payload.id) record.load({ type: record.Type.ESTIMATE, id: Number(payload.id), isDynamic: false });
                else if (user.getPermission({ name: 'TRAN_ESTIMATE' }) < runtime.Permission.CREATE) throw Error('Create Estimate permission is required.');
                if (!/^\d+$/.test(String(payload.entityId || ''))) throw Error('A valid customer is required.');
                record.load({ type: record.Type.CUSTOMER, id: Number(payload.entityId), isDynamic: false });
                const currencyId = payload.body.currency;
                const currency = record.load({ type: record.Type.CURRENCY, id: Number(currencyId), isDynamic: false });
                const iso = String(read(currency, 'symbol') || 'CAD');
                const formatter = i18n.getCurrencyFormatter({ currency: iso });
                const data = lib.model(payload, rich, n => formatter.format({ number: n }), raw => {
                    const entries = raw.split(',').map(v => v.trim()).filter(Boolean);
                    if (entries.length > 10) throw Error('At most 10 supporting PDFs can be previewed.');
                    return entries.map(v => lib.escape(mediaURL(v, true))).join(',');
                });
                const company = config.load({ type: config.Type.COMPANY_INFORMATION });
                const logoId = read(company, 'formlogo');
                const companyData = { email: lib.escape(read(company, 'email')), logoUrl: logoId ? mediaURL(logoId, false) : '' };
                const sub = record.load({ type: record.Type.SUBSIDIARY, id: Number(payload.body.subsidiary), isDynamic: false });
                let address = read(sub, 'mainaddress_text');
                if (!address) address = sub.getSubrecord({ fieldId: 'mainaddress' }).getValue({ fieldId: 'addrtext' });
                const subsidiaryData = { mainaddress_text: lib.escape(address).replace(/\r?\n/g, '<br />') };
                let mobile = '';
                try { mobile = read(record.load({ type: record.Type.EMPLOYEE, id: user.id }), 'mobilephone'); }
                catch (_) { /* Mobile is optional; no extra employee permission is required. */ }
                const renderer = render.create();
                renderer.setTemplateByScriptId({ scriptId: lib.TEMPLATE });
                renderer.templateContent = lib.adaptTemplate(lib.TEMPLATE_SOURCE);
                const sources = { previewRecord: data, previewCompany: companyData, previewSubsidiary: subsidiaryData,
                    previewUser: { email: lib.escape(user.email), mobilephone: lib.escape(mobile) } };
                Object.keys(sources).forEach(alias => renderer.addCustomDataSource({ format: render.DataSource.OBJECT, alias, data: sources[alias] }));
                const renderedXml = renderer.renderAsString();
                let pdf;
                try { pdf = render.xmlToPdf({ xmlString: renderedXml }); }
                catch (renderError) {
                    const refs = Array.from(renderedXml.matchAll(/(?:src|src-bold|src-italic|src-bolditalic)="([^"]*)"/g)).map(m => /^data:/.test(m[1]) ? '[embedded image]' : m[1].split('?')[0]);
                    throw Error(String(renderError.message) + ' Resources: ' + refs.join(' | '));
                }
                pdf.name = 'Estimate_' + String(payload.body.tranid || 'Unsaved').replace(/[^a-z0-9_-]/gi, '_') + '_Preview.pdf';
                ctx.response.writeFile({ file: pdf, isInline: true });
            } catch (e) {
                // Do not log the snapshot, proposal text, XML, or customer information.
                log.error({ title: 'Estimate preview failed', details: String(e.name || 'PREVIEW_ERROR') });
                ctx.response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
                const raw = String(e.message || 'Preview generation failed.');
                const safe = /<|\$\{/.test(raw) ? 'The PDF template could not render. Check the template field mappings and rich-text formatting.' : raw.slice(0, 500);
                ctx.response.write({ output: JSON.stringify({ ok: false, message: safe }) });
            }
        }
        return { onRequest };
    });
