/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Script 1.0 (part A) — adds the "Generate Project & Sales Order" button to the
 * Estimate form. Button only appears in VIEW mode when the estimate is
 * customer-approved AND has not already generated a project.
 *
 * Owner: BlueCollar (Tom F.)
 */
define(['N/search', 'N/ui/serverWidget'], function (search, serverWidget) {

  // ---- Config constants (confirm during dev) -------------------------------
  var FIELD = {
    APPROVAL_STATUS: 'custbody_bc_approval_stat_est', // exists on record (sample value = 2)
    PROJECT_GENERATED: 'custbody_bc_project_generated',
    ESTIMATE_TYPE: 'custbody_bc_estimate_type',
    LINE_SITE_ASSET: 'custcol_nx_asset',
    SOURCE_ESTIMATE: 'custentity_bc_source_estimate'
  };

  var APPROVED_STATUS_VALUE = '2';
  var ESTIMATE_TYPE_STANDARD = '1';
  var ESTIMATE_TYPE_ROLLOUT = '2';

  function beforeLoad(ctx) {
    if (ctx.type !== ctx.UserEventType.VIEW) return;

    var rec = ctx.newRecord;
    var approved = String(rec.getValue({ fieldId: FIELD.APPROVAL_STATUS })) === APPROVED_STATUS_VALUE;
    var alreadyGenerated = rec.getValue({ fieldId: FIELD.PROJECT_GENERATED }) === true;
    var progress = getProjectProgress(rec);
    var form = ctx.form;

    form.clientScriptModulePath = './bc_cs_estimate_generate.js';
    if (shouldShowInlineProgress(progress)) {
      addProjectProgressField(form, progress);
    }

    if (!approved || alreadyGenerated) return;

    form.addButton({
      id: 'custpage_bc_gen_proj_so',
      label: 'Generate Project & Sales Order',
      functionName: 'bcGenerateProjectAndSO'
    });
  }

  function getProjectProgress(rec) {
    var expected = getExpectedProjectCount(rec);
    var created = getCreatedProjectCount(rec.id);
    var percent = expected > 0 ? Math.min(100, Math.round((created / expected) * 100)) : 0;
    var estimateType = String(rec.getValue({ fieldId: FIELD.ESTIMATE_TYPE }) || '');

    return {
      estimateType: estimateType,
      expected: expected,
      created: created,
      remaining: Math.max(expected - created, 0),
      percent: percent,
      generated: rec.getValue({ fieldId: FIELD.PROJECT_GENERATED }) === true,
      statusCode: getProjectProgressStatusCode(expected, created, rec.getValue({ fieldId: FIELD.PROJECT_GENERATED }) === true)
    };
  }

  function shouldShowInlineProgress(progress) {
    return progress.statusCode === 'PROCESSING' || progress.statusCode === 'WARNING';
  }

  function getExpectedProjectCount(rec) {
    var estimateType = String(rec.getValue({ fieldId: FIELD.ESTIMATE_TYPE }) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) return 1;

    if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
      var siteCount = getUniqueLineSiteCount(rec);
      return siteCount > 0 ? siteCount + 1 : 0; // one parent plus one child per site
    }

    return 0;
  }

  function getUniqueLineSiteCount(rec) {
    var seen = {};
    var count = 0;
    var lineCount = rec.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = 0; i < lineCount; i++) {
      var siteId = rec.getSublistValue({
        sublistId: 'item',
        fieldId: FIELD.LINE_SITE_ASSET,
        line: i
      });

      if (!siteId || seen[String(siteId)]) continue;
      seen[String(siteId)] = true;
      count++;
    }

    return count;
  }

  function getCreatedProjectCount(estId) {
    if (!estId) return 0;

    return search.create({
      type: search.Type.JOB,
      filters: [[FIELD.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: ['internalid']
    }).runPaged({ pageSize: 1 }).count;
  }

  function addProjectProgressField(form, progress) {
    var field = form.addField({
      id: 'custpage_bc_project_progress',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Project Progress'
    });

    field.defaultValue = buildProjectProgressHtml(progress);
  }

  function buildProjectProgressHtml(progress) {
    var status = getProjectProgressStatus(progress);
    var label = getEstimateTypeLabel(progress.estimateType);

    return '' +
      '<div style="margin:12px 0 16px 0;padding:12px;border:1px solid #d9e2ec;background:#f8fafc;max-width:860px;font-family:Arial,sans-serif;">' +
        '<div style="display:flex;align-items:center;gap:12px;">' +
          '<div style="flex:1;min-width:280px;">' +
            '<div style="display:flex;justify-content:space-between;gap:16px;margin-bottom:8px;">' +
              '<div style="font-weight:700;color:#1f2937;">Project Generation Progress</div>' +
              '<div style="color:#4b5563;">' + escapeHtml(label) + '</div>' +
            '</div>' +
            '<div style="height:14px;background:#e5e7eb;border-radius:7px;overflow:hidden;">' +
              '<div style="height:14px;width:' + progress.percent + '%;background:' + getBarColor(progress.statusCode) + ';"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;gap:16px;margin-top:8px;color:#374151;">' +
              '<div>' + escapeHtml(status) + '</div>' +
              '<div>Projects: ' + progress.created + ' of ' + progress.expected + ' | Remaining: ' + progress.remaining + '</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" onclick="bcViewProjectProgress();" style="border:1px solid #9ca3af;background:#fff;color:#1f2937;padding:6px 12px;cursor:pointer;white-space:nowrap;">Show Progress</button>' +
        '</div>' +
      '</div>';
  }

  function getProjectProgressStatus(progress) {
    if (progress.statusCode === 'WARNING') return 'Generated flag set, but project count does not match';
    if (!progress.expected) return 'Waiting for project criteria';
    if (progress.created >= progress.expected) return 'Project creation complete';
    if (progress.created > 0) return 'Project creation in progress';
    return 'Not started';
  }

  function getProjectProgressStatusCode(expected, created, generated) {
    if (!expected) return 'WAITING';
    if (created >= expected) return 'COMPLETE';
    if (generated && created < expected) return 'WARNING';
    if (created > 0) return 'PROCESSING';
    return 'NOT_STARTED';
  }

  function getBarColor(statusCode) {
    if (statusCode === 'WARNING') return '#d97706';
    if (statusCode === 'COMPLETE') return '#059669';
    return '#2563eb';
  }

  function getEstimateTypeLabel(value) {
    if (value === ESTIMATE_TYPE_STANDARD) return 'Standard';
    if (value === ESTIMATE_TYPE_ROLLOUT) return 'Rollout';
    return 'Estimate Type Missing';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return { beforeLoad: beforeLoad };
});
