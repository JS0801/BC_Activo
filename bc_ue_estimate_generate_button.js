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
define(['N/search', 'N/ui/serverWidget', 'N/record'], function (search, serverWidget, record) {

  // ---- Config constants (confirm during dev) -------------------------------
  var FIELD = {
    APPROVAL_STATUS: 'custbody_bc_approval_stat_est', // exists on record (sample value = 2)
    PROJECT_GENERATED: 'custbody_bc_project_generated',
    ESTIMATE_TYPE: 'custbody_bc_estimate_type',
    GENERATION_STATUS: 'custbody_bc_generation_status',
    ERROR_DETAILS: 'custbody_bc_error_details',
    LINE_SITE_ASSET: 'custcol_nx_asset',
    SOURCE_ESTIMATE: 'custentity_bc_source_estimate',
    TASK_SOURCE_ESTIMATE: 'custevent_bc_source_estimate',
    SO_SOURCE_ESTIMATE: 'custbody_bc_source_estimate'
  };

  var STAGING = {
    TYPE: 'customrecord_nscpq_task_staging',
    JSON: 'custrecord_task_json',
    TRANSACTION: 'custrecord_task_transaction'
  };

  var APPROVED_STATUS_VALUE = '2';
  var ESTIMATE_TYPE_STANDARD = '1';
  var ESTIMATE_TYPE_ROLLOUT = '2';
  var GEN_STATUS = {
    PENDING: '1',
    PROCESSING: '2',
    COMPLETED: '3',
    FAILED: '4',
    PARTIAL_ERROR: '5',
    RETRY_PENDING: '6'
  };

  // SANDBOX TEST ONLY: keep aligned with the Suitelet test constants.
  var PROGRESS_TEST_MODE = false;
  var PROGRESS_TEST_STANDARD_PROJECT_COUNT = 10;

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

    if (!approved || alreadyGenerated || progress.hasStarted) return;

    form.addButton({
      id: 'custpage_bc_gen_proj_so',
      label: 'Generate Project & Sales Order',
      functionName: 'bcGenerateProjectAndSO'
    });
  }

  const afterSubmit = (context) => {
    if (context.type === context.UserEventType.DELETE) {
      return;
    }

    const newRec = context.newRecord;
    const estimateType = newRec.getValue({ fieldId: 'custbody_bc_estimate_type' });
    const bodyAsset = newRec.getValue({ fieldId: 'custbody_nx_asset' });

    let noOfSites = 0;

    if (String(estimateType) === '1') {
      noOfSites = bodyAsset ? 1 : 0;
    }

    if (String(estimateType) === '2') {
      const assetCountCol = search.createColumn({
        name: 'custcol_nx_asset',
        summary: search.Summary.COUNT,
        label: 'Field Service Asset (trans)'
      });

      const transactionSearchObj = search.create({
        type: 'transaction',
        filters: [
          ['internalid', 'anyof', newRec.id]
        ],
        columns: [
          assetCountCol
        ]
      });

      transactionSearchObj.run().each((result) => {
        noOfSites = Number(result.getValue(assetCountCol)) || 0;
        return false;
      });
    }

    const currentValue = Number(newRec.getValue({ fieldId: 'custbody_no_of_sites' })) || 0;

    if (currentValue !== noOfSites) {
      record.submitFields({
        type: newRec.type,
        id: newRec.id,
        values: {
          custbody_no_of_sites: noOfSites
        },
        options: {
          enableSourcing: false,
          ignoreMandatoryFields: true
        }
      });
    }
  };

  function getProjectProgress(rec) {
    var estimateType = String(rec.getValue({ fieldId: FIELD.ESTIMATE_TYPE }) || '');
    var expectedProjects = getExpectedProjectCount(rec);
    var expectedTasks = getExpectedProjectTaskCount(rec.id);
    var expectedSalesOrders = getExpectedSalesOrderCount(rec);
    var createdProjects = getCreatedProjectCount(rec.id);
    var createdTasks = getCreatedProjectTaskCount(rec.id);
    var createdSalesOrders = getCreatedSalesOrderCount(rec.id);
    var expected = expectedProjects + expectedTasks + expectedSalesOrders;
    var created = createdProjects + createdTasks + createdSalesOrders;
    var percent = expected > 0 ? Math.min(100, Math.round((created / expected) * 100)) : 0;
    var generated = rec.getValue({ fieldId: FIELD.PROJECT_GENERATED }) === true;
    var generationStatus = String(rec.getValue({ fieldId: FIELD.GENERATION_STATUS }) || '');
    var savedErrorCount = getSavedErrorCount(rec.getValue({ fieldId: FIELD.ERROR_DETAILS }));
    var hasStarted = generated || created > 0 || isGenerationStatusStarted(generationStatus) || savedErrorCount > 0;
    var statusCode = getGenerationProgressStatusCode({
      expected: expected,
      created: created,
      generated: generated,
      hasStarted: hasStarted,
      generationStatus: generationStatus,
      savedErrorCount: savedErrorCount
    });
    if (hasStarted && percent === 0 && generationStatus !== GEN_STATUS.FAILED) percent = 8;

    return {
      estimateType: estimateType,
      expected: expected,
      created: created,
      remaining: Math.max(expected - created, 0),
      expectedProjects: expectedProjects,
      createdProjects: createdProjects,
      expectedTasks: expectedTasks,
      createdTasks: createdTasks,
      expectedSalesOrders: expectedSalesOrders,
      createdSalesOrders: createdSalesOrders,
      percent: percent,
      generated: generated,
      hasStarted: hasStarted,
      statusCode: statusCode,
      generationStatus: generationStatus,
      savedErrorCount: savedErrorCount
    };
  }

  function shouldShowInlineProgress(progress) {
    return progress.hasStarted && progress.statusCode !== 'COMPLETE';
  }

  function getExpectedProjectCount(rec) {
    var estimateType = String(rec.getValue({ fieldId: FIELD.ESTIMATE_TYPE }) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      return PROGRESS_TEST_MODE ? PROGRESS_TEST_STANDARD_PROJECT_COUNT : 1;
    }

    if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
      var siteCount = getUniqueLineSiteCount(rec);
      return siteCount > 0 ? siteCount + 1 : 0; // one parent plus one child per site
    }

    return 0;
  }

  function getExpectedProjectTaskCount(estId) {
    if (!estId) return 0;

    var count = 0;

    search.create({
      type: STAGING.TYPE,
      filters: [[STAGING.TRANSACTION, 'anyof', estId]],
      columns: [search.createColumn({ name: STAGING.JSON })]
    }).run().each(function (result) {
      count += getTaskJsonCount(result.getValue({ name: STAGING.JSON }));
      return true;
    });

    return count;
  }

  function getExpectedSalesOrderCount(rec) {
    var estimateType = String(rec.getValue({ fieldId: FIELD.ESTIMATE_TYPE }) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) return 1;
    if (estimateType === ESTIMATE_TYPE_ROLLOUT) return getUniqueLineSiteCount(rec);

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

  function getCreatedProjectTaskCount(estId) {
    if (!estId) return 0;

    return search.create({
      type: search.Type.PROJECT_TASK || 'projecttask',
      filters: [[FIELD.TASK_SOURCE_ESTIMATE, 'anyof', estId]],
      columns: ['internalid']
    }).runPaged({ pageSize: 1 }).count;
  }

  function getCreatedSalesOrderCount(estId) {
    if (!estId) return 0;

    return search.create({
      type: search.Type.SALES_ORDER,
      filters: [
        [FIELD.SO_SOURCE_ESTIMATE, 'anyof', estId],
        'AND',
        ['mainline', 'is', 'T']
      ],
      columns: ['internalid']
    }).runPaged({ pageSize: 1 }).count;
  }

  function getTaskJsonCount(jsonText) {
    if (!jsonText) return 0;

    try {
      var parsed = JSON.parse(jsonText);
      return Array.isArray(parsed) ? parsed.length : 1;
    } catch (e) {
      return 0;
    }
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
      '<div id="bc_inline_project_progress" style="margin:8px 0 10px 0;padding:8px 10px;border:1px solid #d9e2ec;background:#f8fafc;max-width:720px;font-family:Arial,sans-serif;border-radius:4px;">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div style="flex:1;min-width:240px;">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:5px;font-size:12px;">' +
              '<div style="font-weight:700;color:#1f2937;">Generation Progress</div>' +
              '<div style="color:#4b5563;">' + escapeHtml(label) + '</div>' +
            '</div>' +
            '<div style="height:9px;background:#e5e7eb;border-radius:5px;overflow:hidden;">' +
              '<div style="height:9px;width:' + progress.percent + '%;background:' + getBarColor(progress.statusCode) + ';"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;gap:12px;margin-top:5px;color:#374151;font-size:12px;">' +
              '<div>' + escapeHtml(status) + '</div>' +
              '<div>Total: ' + progress.created + ' of ' + progress.expected + ' | Remaining: ' + progress.remaining + '</div>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;color:#4b5563;font-size:11px;">' +
              '<span>Projects: ' + progress.createdProjects + '/' + progress.expectedProjects + '</span>' +
              '<span>Tasks: ' + progress.createdTasks + '/' + progress.expectedTasks + '</span>' +
              '<span>Sales Orders: ' + progress.createdSalesOrders + '/' + progress.expectedSalesOrders + '</span>' +
              (progress.savedErrorCount ? '<span>Issues: ' + progress.savedErrorCount + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<button type="button" onclick="bcRefreshInlineProjectProgress(this);" style="border:1px solid #9ca3af;background:#fff;color:#1f2937;padding:5px 10px;cursor:pointer;white-space:nowrap;border-radius:4px;font-size:12px;">Refresh</button>' +
          '<button type="button" onclick="bcViewProjectProgress();" style="border:1px solid #9ca3af;background:#fff;color:#1f2937;padding:5px 10px;cursor:pointer;white-space:nowrap;border-radius:4px;font-size:12px;">Show Progress</button>' +
          '<button type="button" title="Close" onclick="var el=document.getElementById(\'bc_inline_project_progress\');if(el){el.style.display=\'none\';}" style="border:1px solid #cbd5e1;background:#fff;color:#1f2937;width:24px;height:24px;cursor:pointer;border-radius:4px;font-weight:700;">x</button>' +
        '</div>' +
      '</div>';
  }

  function getProjectProgressStatus(progress) {
    if (progress.statusCode === 'FAILED') return 'Generation failed. Open progress for details and retry options.';
    if (progress.statusCode === 'RETRY_PENDING') return 'Retry is pending background processing';
    if (progress.statusCode === 'PENDING') return 'Generation is pending background processing';
    if (progress.statusCode === 'PARTIAL_ERROR') return 'Generation has errors. Open progress for details and retry options.';
    if (progress.statusCode === 'WARNING') return 'Generated flag set, but generated record count does not match';
    if (progress.statusCode === 'COMPLETE') return 'Generation complete';
    if (!progress.expected) return 'Waiting for generation criteria';
    if (progress.created > 0 || progress.hasStarted) return 'Generation in progress';
    return 'Not started';
  }

  function getGenerationProgressStatusCode(progress) {
    if (progress.generationStatus === GEN_STATUS.PENDING) return 'PENDING';
    if (progress.generationStatus === GEN_STATUS.PROCESSING) return 'PROCESSING';
    if (progress.generationStatus === GEN_STATUS.COMPLETED) return 'COMPLETE';
    if (progress.generationStatus === GEN_STATUS.FAILED) return 'FAILED';
    if (progress.generationStatus === GEN_STATUS.PARTIAL_ERROR) return 'PARTIAL_ERROR';
    if (progress.generationStatus === GEN_STATUS.RETRY_PENDING) return 'RETRY_PENDING';
    if (progress.savedErrorCount > 0) return 'PARTIAL_ERROR';
    if (!progress.expected) return 'WAITING';
    if (progress.generated && progress.created >= progress.expected) return 'COMPLETE';
    if (progress.generated && progress.created < progress.expected) return 'WARNING';
    if (progress.hasStarted) return 'PROCESSING';
    return 'NOT_STARTED';
  }

  function getBarColor(statusCode) {
    if (statusCode === 'WARNING' || statusCode === 'PARTIAL_ERROR' || statusCode === 'RETRY_PENDING') return '#d97706';
    if (statusCode === 'COMPLETE') return '#059669';
    if (statusCode === 'FAILED') return '#dc2626';
    return '#2563eb';
  }

  function isGenerationStatusStarted(status) {
    return status === GEN_STATUS.PENDING ||
      status === GEN_STATUS.PROCESSING ||
      status === GEN_STATUS.FAILED ||
      status === GEN_STATUS.PARTIAL_ERROR ||
      status === GEN_STATUS.RETRY_PENDING;
  }

  function getSavedErrorCount(raw) {
    if (!raw) return 0;

    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.length;
      return parsed.errors && parsed.errors.length ? parsed.errors.length : 0;
    } catch (e) {
      return 1;
    }
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

  return { beforeLoad: beforeLoad, afterSubmit: afterSubmit };
});
