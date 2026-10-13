/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * Shared snapshot schema and template adapter. No record writes.
 */
define([], () => {
    const TEMPLATE = 'custtmpl_210_8488975_sb1_375';
    const SCRIPT = 'customscript_bc_estimate_preview_sl';
    const DEPLOYMENT = 'customdeploy_bc_estimate_preview_sl';
    const TEXT = ['entity', 'billaddress', 'title', 'tranid'];
    const RICH = ['custbody_nscpq_proposal_cover_letter', 'custbody_nscpq_proposal_sow', 'custbody_nscpq_proposal_tcs'];
    const FLAGS = ['custbody_nscpq_proposal_bom_driven_sow', 'custbody_nscpq_proposal_no_pn',
        'custbody_nscpq_prosposal_no_pricing', 'custbody_nscpq_proposal_pi_no_sig',
        'custbody_nscpq_proposal_incl_sig_line', 'custbody_nscpq_proposal_ds_no_sig',
        'custbody_nscpq_proposal_ds_sig_options', 'custbody_cpq_itemized_pricing', 'custbody_cpq_summ_group_pricing'];
    const BODY = TEXT.concat(RICH, FLAGS, ['total', 'subsidiary', 'currency', 'custbody_supporting_pdfs']);
    const LINE = ['item', 'description', 'quantity', 'rate', 'amount', 'custcol_cpq_subsection'];
    const MAX_BODY = 2000000;
    const MAX_LINES = 1000;
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const bool = v => v === true || v === 'T' || v === 'Yes' || v === 'true';
    const str = v => v == null ? '' : String(v);
    const escape = v => str(v).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
    function number(v, field) {
        if (v === '' || v == null) return 0;
        const n = Number(v);
        if (!Number.isFinite(n)) throw Error('Invalid numeric value for ' + field);
        return n;
    }
    function validate(payload) {
        if (!payload || payload.version !== 1 || !payload.body || !Array.isArray(payload.items)) throw Error('Invalid preview snapshot. Reload the Estimate.');
        if (!['create', 'copy', 'edit', 'view'].includes(payload.mode)) throw Error('Invalid preview mode.');
        if (payload.items.length > MAX_LINES) throw Error('Preview supports up to ' + MAX_LINES + ' item lines.');
        if (payload.id && !/^\d+$/.test(str(payload.id))) throw Error('Invalid Estimate ID.');
        if (!payload.body.entity) throw Error('Select a customer before previewing.');
        if (payload.body.total === '' || payload.body.total == null) throw Error('Estimate total is not available yet. Wait for calculation and refresh.');
        number(payload.body.total, 'total');
        payload.items.forEach((line, i) => {
            if (!line || typeof line !== 'object' || !line.item) throw Error('Item is missing on line ' + (i + 1));
            ['quantity', 'amount'].forEach(k => number(line[k], k + ' on line ' + (i + 1)));
            if (!/^-?\d+(?:\.\d+)?%$/.test(str(line.rate))) number(line.rate, 'rate on line ' + (i + 1));
        });
        return payload;
    }
    function model(payload, rich, money, supporting) {
        validate(payload);
        const src = payload.body, out = {};
        TEXT.forEach(k => { out[k] = escape(src[k]); });
        out.billaddress = escape(src.billaddress).replace(/&lt;br\s*\/?&gt;|\r?\n/gi, '<br />');
        out.tranid = escape(src.tranid || 'Unsaved');
        FLAGS.forEach(k => { out[k] = bool(src[k]); });
        // Original template compares these two to Yes/T, unlike its other flags.
        ['custbody_cpq_itemized_pricing', 'custbody_cpq_summ_group_pricing'].forEach(k => { out[k] = bool(src[k]) ? 'T' : 'F'; });
        RICH.forEach(k => { out[k] = rich(str(src[k]), k); });
        out.total = escape(money(number(src.total, 'total')));
        out.custbody_supporting_pdfs = supporting(str(src.custbody_supporting_pdfs));
        out.item = payload.items.map(line => ({
            item: escape(line.item), description: escape(line.description).replace(/\r?\n/g, '<br />'),
            quantity: line.quantity === '' || line.quantity == null ? '' : number(line.quantity, 'quantity'),
            rate: line.rate === '' || line.rate == null ? '' : /%$/.test(str(line.rate)) ? escape(line.rate) : escape(money(number(line.rate, 'rate'))),
            amount: number(line.amount, 'amount'), amount_display: escape(money(number(line.amount, 'amount'))),
            custcol_cpq_subsection: escape(line.custcol_cpq_subsection)
        }));
        return out;
    }
    function adaptTemplate(source) {
        // JSON has no NetSuite @label metadata. Only adapt this template's known labels.
        let text = source.replace(/record\.item\[0\]\.quantity@label/g, '"Quantity"')
            .replace(/record\.item\[0\]\.item@label/g, '"Item"')
            .replace(/record\.item\[0\]\.amount@label/g, '"Amount"')
            .replace(/record@title/g, '"Estimate"')
            .replace(/\$\{item\.amount\}/g, '${item.amount_display}')
            .replace(/\brecord\./g, 'previewRecord.')
            .replace(/\bcompanyInformation\./g, 'previewCompany.')
            .replace(/\bcompanyinformation\./g, 'previewCompany.')
            .replace(/\bsubsidiary\./g, 'previewSubsidiary.')
            .replace(/\buser\./g, 'previewUser.');
        const known = TEXT.concat(RICH, FLAGS, ['total', 'item', 'custbody_supporting_pdfs']);
        for (const match of text.matchAll(/previewRecord\.([A-Za-z_0-9]+)/g)) {
            if (!known.includes(match[1])) throw Error('Template uses an unmapped field: ' + match[1] + '. Update the preview field map.');
        }
        if (/previewRecord[^\n}]*@(?:label|title)/.test(text)) throw Error('Template contains unmapped field labels. Update the preview adapter.');
        return text;
    }
    return { TEMPLATE, SCRIPT, DEPLOYMENT, BODY, LINE, FLAGS, RICH, MAX_BODY, MAX_LINES, has, bool, str, escape, number, validate, model, adaptTemplate };
});
