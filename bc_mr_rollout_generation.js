/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Script 1.0 (part C) — server-side generator.
 *
 * Phase 1 scope:
 * - Validate the approved Estimate.
 * - Create Project records for Standard and Rollout Estimates.
 * - Link generated Projects back to the source Estimate.
 * - Mark the Estimate as project-generated for this project-creation phase.
 *
 * Later phase:
 * - Create Project Tasks from CPQ staging records.
 * - Create related Sales Order records from CPQ component data.
 */
define(['N/record', 'N/search', 'N/log', 'N/format', 'N/task'], function (record, search, log, format, taskModule) {

  // ---- Estimate field IDs --------------------------------------------------
  var EST = {
    ENTITY: 'entity',
    TRANID: 'tranid',
    SUBSIDIARY: 'subsidiary',
    SALESREP: 'salesrep',
    DEPARTMENT: 'department',
    CLASS: 'class',
    LOCATION: 'location',
    TRANDATE: 'trandate',
    PROJECTMANAGER: 'custbody_bc_project_manager',
    PROJECT_START: 'custbody_bc_project_start_date',
    PROJECT_END: 'custbody_bc_est_end_date',
    SITE_ASSET: 'custbody_nx_asset',
    FSM_CUSTOMER: 'custbody_nx_customer',
    APPROVAL_STATUS: 'custbody_bc_approval_stat_est',
    ESTIMATE_TYPE: 'custbody_bc_estimate_type',
    PROJECT_GENERATED: 'custbody_bc_project_generated',
    GENERATED_PROJECT: 'custbody_bc_project',
    GENERATION_STATUS: 'custbody_bc_generation_status',
    ERROR_DETAILS: 'custbody_bc_error_details'
  };

  // ---- Estimate line field IDs --------------------------------------------
  var EST_LINE = {
    SITE_ASSET: 'custcol_nx_asset',
    STAGING_IDS: 'custcol_nscpq_proj_task_staging_ids',
    RELATED_SALES_ORDER: 'custcol_bc_related_sales_order',
    CPQ_KIT_JSON: 'custcol_nscpq_trx_kit_json',
    TAX_CODE: 'taxcode'
  };

  var SO_LINE_JSON_FIELD = {
    HOURS: 'custcol_bc_hours',
    NUM_RUNS: 'custcol_bc_no_of_runs',
    AVG_RUN_LENGTH: 'custcol_bc_avg_run_length',
    UNIT_COST: 'custcol_bc_unit_cost',
    EXTENDED_COST: 'custcol_bc_extended_cost',
    GROSS_MARGIN: 'custcol_bc_gross_margin'
  };

  var CPQ_UOM_BY_NAME = {
    each: '2',
    ea: '2',
    hour: '3',
    hours: '3',
    hr: '3',
    meter: '1',
    meters: '1',
    metre: '1',
    metres: '1',
    mtr: '1',
    revenue: '4'
  };

  // ---- CPQ Project Task Staging field IDs ------------------------------------
  var STAGING = {
    TYPE: 'customrecord_nscpq_task_staging',
    NAME: 'name',
    JSON: 'custrecord_task_json',
    TRANSACTION: 'custrecord_task_transaction',
    LINE_REF: 'custrecord_task_line_ref'
  };

  // ---- Project Task field IDs -------------------------------------------------
  var TASK = {
    PROJECT: 'company',
    TITLE: 'title',
    SOURCE_ESTIMATE: 'custevent_bc_source_estimate',
    ASSET: 'custevent_nx_task_asset'
  };

  // ---- Project field IDs ---------------------------------------------------
  var PROJ = {
    NAME: 'companyname',
    CUSTOMER_PARENT: 'parent', // UI label is Customer; field ID on Job/Project is parent.
    SUBSIDIARY: 'subsidiary',
    STARTDATE: 'startdate',
    PROJECTED_END: 'projectedenddate',
    SALESREP: 'custentity_salesrep',
    DEPARTMENT: 'department',
    CLASS: 'class',
    LOCATION: 'location',
    PROJECTMANAGER: 'projectmanager',
    FS_PROJECT_TYPE: 'custentity_nx_project_type',
    SITE_ASSET: 'custentity_nx_asset',
    FS_CUSTOMER: 'custentity_nx_customer',
    SOURCE_ESTIMATE: 'custentity_bc_source_estimate',
    SEARCH_CUSTOMER: 'customer'
  };

  // ---- Sales Order field IDs -----------------------------------------------
  var SO = {
    PROJECT: 'job',
    SOURCE_ESTIMATE: 'custbody_bc_source_estimate'
  };

  var APPROVED_STATUS_VALUE = '2';
  var ESTIMATE_TYPE_STANDARD = '1';
  var ESTIMATE_TYPE_ROLLOUT = '2';
  var FIXED_FEE_PROJECT_TYPE = '18';
  var STANDARD_ASYNC_RECORD_THRESHOLD = 20;
  var ROLLOUT_ASYNC_SITE_THRESHOLD = 10;
  var ROLLOUT_MR_SCRIPT_ID = 'customscript_bc_mr_rollout_generation';
  var ROLLOUT_MR_DEPLOY_NOW = 'customdeploy_bc_mr_rollout_gen_now';
  var MR_PARAM_ESTIMATE_ID = 'custscript_bc_rollout_estimate_id';

  var GEN_STATUS = {
    PENDING: '1',
    PROCESSING: '2',
    COMPLETED: '3',
    FAILED: '4',
    PARTIAL_ERROR: '5',
    RETRY_PENDING: '6'
  };

  var GEN_STATUS_LABEL = {
    '1': 'Pending',
    '2': 'Processing',
    '3': 'Completed',
    '4': 'Failed',
    '5': 'Partial Error',
    '6': 'Retry Pending'
  };

  function onRequest(ctx) {
    var out = { success: false };

    try {
      var estId = ctx.request.parameters.estid;
      if (!estId) throw new Error('Missing estid parameter.');
      var action = String(ctx.request.parameters.action || '');

      if (action === 'progress') {
        writeProjectProgressPage(ctx, estId);
        return;
      }

      if (action === 'inline_progress') {
        writeInlineProjectProgress(ctx, estId);
        return;
      }

      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });

      if (action === 'retry') {
        out = retryGenerationItem(est, estId, ctx.request.parameters.key || ctx.request.parameters.retrykey || '');
      } else if (action === 'retry_all') {
        out = retryAllGeneration(est, estId);
      } else if (action === 'retry_remaining') {
        out = retryRemainingGeneration(est, estId);
      } else {
        validateEstimate(est, estId);

        var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

        if (estimateType === ESTIMATE_TYPE_STANDARD) {
          out = runStandardProjectCreation(est, estId);
        } else if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
          out = runRolloutProjectCreation(est, estId);
        } else {
          throw new Error('Unsupported or missing Estimate Type. Expected Standard (1) or Rollout (2).');
        }
      }
    } catch (e) {
      try {
        persistUnhandledGenerationFailure(estId, action, e);
      } catch (statusError) {
        log.error({
          title: 'BC Generation failure status update failed',
          details: JSON.stringify({
            estimateId: estId || '',
            action: action || '',
            originalError: getErrorDetails(e),
            statusError: getErrorDetails(statusError)
          })
        });
      }
      out.success = false;
      out.error = e.message || String(e);
    }

    if (ctx.request.parameters.format === 'json') {
      ctx.response.write({ output: JSON.stringify(out) });
    } else {
      ctx.response.write({ output: buildGenerationResultPage(out) });
    }
  }

  function writeProjectProgressPage(ctx, estId) {
    var est = record.load({
      type: record.Type.ESTIMATE,
      id: estId,
      isDynamic: false
    });

    var progress = getProjectProgress(est, estId);
    ctx.response.write({ output: buildProjectProgressPage(progress) });
  }

  function writeInlineProjectProgress(ctx, estId) {
    var est = record.load({
      type: record.Type.ESTIMATE,
      id: estId,
      isDynamic: false
    });

    var progress = getProjectProgress(est, estId);
    ctx.response.write({ output: buildInlineProjectProgressHtml(progress) });
  }

  function getProjectProgress(est, estId) {
    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');
    var expected = getExpectedProjectCount(est);
    var expectedTasks = getExpectedProjectTaskCount(est, estId);
    var expectedSalesOrders = getExpectedSalesOrderCount(est);
    var projects = getGeneratedProjects(estId);
    var tasks = getGeneratedProjectTasks(estId);
    var salesOrders = getGeneratedSalesOrders(estId);
    var errorDetails = readGenerationErrorDetails(est);
    var errorSummary = getProgressErrorSummary(errorDetails.errors);
    var created = projects.length;
    var createdTotal = projects.length + tasks.length + salesOrders.length;
    var expectedTotal = expected + expectedTasks + expectedSalesOrders;
    var percent = expected > 0 ? Math.min(100, Math.round((created / expected) * 100)) : 0;
    var totalPercent = expectedTotal > 0 ? Math.min(100, Math.round((createdTotal / expectedTotal) * 100)) : 0;
    var taskPercent = expectedTasks > 0 ? Math.min(100, Math.round((tasks.length / expectedTasks) * 100)) : 0;
    var salesOrderPercent = expectedSalesOrders > 0 ? Math.min(100, Math.round((salesOrders.length / expectedSalesOrders) * 100)) : 0;
    var generated = est.getValue(EST.PROJECT_GENERATED) === true;
    var generationStatus = String(est.getValue(EST.GENERATION_STATUS) || '');
    var status = getProjectProgressStatusDetails({
      expectedTotal: expectedTotal,
      createdTotal: createdTotal,
      generated: generated,
      generationStatus: generationStatus,
      errorCount: errorDetails.errors.length
    });

    return {
      estimateId: estId,
      estimateTranId: est.getValue(EST.TRANID),
      estimateType: estimateType,
      expectedTotal: expectedTotal,
      createdTotal: createdTotal,
      remainingTotal: Math.max(expectedTotal - createdTotal, 0),
      totalPercent: totalPercent,
      expected: expected,
      created: created,
      remaining: Math.max(expected - created, 0),
      percent: percent,
      expectedTasks: expectedTasks,
      createdTasks: tasks.length,
      remainingTasks: Math.max(expectedTasks - tasks.length, 0),
      taskPercent: taskPercent,
      expectedSalesOrders: expectedSalesOrders,
      createdSalesOrders: salesOrders.length,
      remainingSalesOrders: Math.max(expectedSalesOrders - salesOrders.length, 0),
      salesOrderPercent: salesOrderPercent,
      taskErrorCount: errorSummary.taskErrors,
      blockedTaskCount: errorSummary.blockedTasks,
      salesOrderErrorCount: errorSummary.salesOrderErrors,
      blockedSalesOrderCount: errorSummary.blockedSalesOrders,
      generated: generated,
      generationStatus: generationStatus,
      generationStatusText: getGenerationStatusLabel(generationStatus),
      statusCode: status.code,
      statusText: status.text,
      errors: errorDetails.errors,
      warnings: errorDetails.warnings,
      errorUpdatedAt: errorDetails.updatedAt,
      projects: projects,
      tasks: tasks,
      salesOrders: salesOrders
    };
  }

  function getProgressErrorSummary(errors) {
    var summary = {
      projectErrors: 0,
      taskErrors: 0,
      blockedTasks: 0,
      salesOrderErrors: 0,
      blockedSalesOrders: 0
    };

    for (var i = 0; i < (errors || []).length; i++) {
      var err = errors[i] || {};
      var type = String(err.type || '').toLowerCase();
      var key = String(err.key || '').toLowerCase();
      var blockedBy = String(err.blockedBy || '').toLowerCase();
      var isBlocked = type.indexOf('blocked') !== -1 || key.indexOf('blocked:') === 0 || blockedBy;

      if (type.indexOf('sales order') !== -1 || key.indexOf('so:') !== -1 || key.indexOf('salesorder') !== -1) {
        if (isBlocked) summary.blockedSalesOrders++;
        else summary.salesOrderErrors++;
      } else if (type.indexOf('project task') !== -1 || key.indexOf('task:') === 0) {
        if (isBlocked) summary.blockedTasks++;
        else summary.taskErrors++;
      } else if (type.indexOf('project') !== -1 || key.indexOf('project:') === 0) {
        summary.projectErrors++;
      }
    }

    return summary;
  }

  function getExpectedProjectCount(est) {
    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      return 1;
    }

    if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
      var siteCount = getUniqueLineSites(est).length;
      return siteCount > 0 ? siteCount + 1 : 0;
    }

    return 0;
  }

  function getExpectedSalesOrderCount(est) {
    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) return 1;
    if (estimateType === ESTIMATE_TYPE_ROLLOUT) return getUniqueLineSites(est).length;

    return 0;
  }

  function getGeneratedProjects(estId) {
    var projects = [];

    search.create({
      type: search.Type.JOB,
      filters: [[PROJ.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'entityid' }),
        search.createColumn({ name: PROJ.SEARCH_CUSTOMER }),
        search.createColumn({ name: PROJ.SITE_ASSET })
      ]
    }).run().each(function (result) {
      projects.push({
        id: result.getValue({ name: 'internalid' }),
        name: result.getValue({ name: 'entityid' }),
        parent: result.getText({ name: PROJ.SEARCH_CUSTOMER }) || result.getValue({ name: PROJ.SEARCH_CUSTOMER }),
        site: result.getText({ name: PROJ.SITE_ASSET }) || result.getValue({ name: PROJ.SITE_ASSET })
      });
      return true;
    });

    return projects;
  }

  function getExpectedProjectTaskCount(est, estId) {
    var staging = getTaskStagingRecordsForEstimate(est, estId, { logWarnings: false });
    var expected = 0;

    for (var i = 0; i < staging.records.length; i++) {
      try {
        expected += parseTaskJson(staging.records[i].json, staging.records[i].id).length;
      } catch (e) {
        // Invalid JSON cannot become a task; progress details will expose the failure during generation.
      }
    }

    return expected;
  }

  function getGeneratedProjectTasks(estId) {
    var tasks = [];

    search.create({
      type: search.Type.PROJECT_TASK || 'projecttask',
      filters: [[TASK.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: TASK.TITLE }),
        search.createColumn({ name: TASK.PROJECT }),
        search.createColumn({ name: 'status' }),
        search.createColumn({ name: 'plannedwork' })
      ]
    }).run().each(function (result) {
      tasks.push({
        id: result.getValue({ name: 'internalid' }),
        title: result.getValue({ name: TASK.TITLE }),
        projectId: result.getValue({ name: TASK.PROJECT }),
        project: result.getText({ name: TASK.PROJECT }) || result.getValue({ name: TASK.PROJECT }),
        status: result.getText({ name: 'status' }) || result.getValue({ name: 'status' }),
        plannedwork: result.getValue({ name: 'plannedwork' })
      });
      return true;
    });

    return tasks;
  }

  function getGeneratedSalesOrders(estId) {
    var salesOrders = [];

    search.create({
      type: search.Type.SALES_ORDER,
      filters: [
        [SO.SOURCE_ESTIMATE, 'anyof', estId],
        'AND',
        ['mainline', 'is', 'T']
      ],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: 'tranid' }),
        search.createColumn({ name: 'status' })
      ]
    }).run().each(function (result) {
      salesOrders.push({
        id: result.getValue({ name: 'internalid' }),
        tranid: result.getValue({ name: 'tranid' }),
        status: result.getText({ name: 'status' }) || result.getValue({ name: 'status' })
      });
      return true;
    });

    return salesOrders;
  }

  function buildProjectProgressClientScript() {
    return '<script>' +
      'function bcEscapeHtml(value){return String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\\x27/g,"&#39;");}' +
      'function bcSetRetryStatus(message,state){var el=document.getElementById("bc_retry_status");if(!el)return;el.className="retry-status "+(state||"working");el.innerHTML=message;}' +
      'function bcSetRetryButtons(disabled){var buttons=document.querySelectorAll("[data-retry-button=\\"T\\"]");for(var i=0;i<buttons.length;i++){buttons[i].disabled=disabled;}}' +
      'function bcProgressUrl(){var u=new URL(window.location.href);u.searchParams.set("action","progress");u.searchParams.delete("format");u.searchParams.delete("key");u.searchParams.delete("_ts");return u.toString();}' +
      'function bcRetryUrl(action,key){var u=new URL(window.location.href);u.searchParams.set("action",action);u.searchParams.set("format","json");u.searchParams.set("_ts",String(new Date().getTime()));if(key){u.searchParams.set("key",key);}else{u.searchParams.delete("key");}return u.toString();}' +
      'function bcNotifyParentInlineRefresh(){try{if(window.parent&&window.parent!==window&&typeof window.parent.bcRefreshInlineProjectProgress==="function"){window.parent.bcRefreshInlineProjectProgress();}}catch(ignore){}}' +
      'function bcRefreshProgressSoon(delay){setTimeout(function(){window.location.href=bcProgressUrl();},delay||1000);}' +
      'function bcMarkRetryRow(button){try{var row=button&&button.closest?button.closest("tr"):null;if(row){row.className=(row.className?row.className+" ":"")+"retrying-row";}}catch(ignore){}}' +
      'function bcRestoreRetryButton(button,fallback){if(!button)return;button.disabled=false;button.textContent=button.getAttribute("data-original-text")||fallback||"Retry";}' +
      'function bcRunRetry(action,key,button,label){label=label||"Retry";if(button){button.setAttribute("data-original-text",button.textContent);button.disabled=true;button.textContent="Retrying...";bcMarkRetryRow(button);}bcSetRetryButtons(true);bcSetRetryStatus(bcEscapeHtml(label)+" is running. Please wait.","working");var xhr=new XMLHttpRequest();xhr.open("GET",bcRetryUrl(action,key),true);xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;var result={};try{result=JSON.parse(xhr.responseText||"{}");}catch(parseError){}if(xhr.status>=200&&xhr.status<300&&result.success===true){bcSetRetryStatus(bcEscapeHtml(label)+" finished successfully. Refreshing progress...","success");}else if(xhr.status>=200&&xhr.status<300&&result.partial===true){bcSetRetryStatus(bcEscapeHtml(label)+" finished with remaining issues. Refreshing progress...","warning");}else{var msg=(result&&(result.error||result.message||result.note))||xhr.statusText||"Retry failed.";bcSetRetryStatus(bcEscapeHtml(label)+" finished with an error: "+bcEscapeHtml(msg)+" Refreshing progress...","error");}bcNotifyParentInlineRefresh();bcRefreshProgressSoon(1200);};xhr.onerror=function(){bcSetRetryStatus(bcEscapeHtml(label)+" could not reach the Suitelet. Please try again.","error");bcSetRetryButtons(false);bcRestoreRetryButton(button,"Retry");};xhr.send();}' +
      'function bcRetryOne(key,button){if(!key)return;bcRunRetry("retry",key,button,"Retry");}' +
      'function bcRetryAll(button){bcRunRetry("retry_all","",button,"Retry Failed / Blocked");}' +
      'function bcRetryRemaining(button){bcRunRetry("retry_remaining","",button,"Retry Remaining");}' +
      '</script>';
  }

  function buildProjectProgressPage(progress) {
    var warning = progress.statusCode === 'WARNING' ?
      '<div class="warn">The Estimate is marked generated, but the generated record count does not match the expected count. Review the generated records before re-running.</div>' : '';
    var rows = progress.projects.length ? progress.projects.map(function (project) {
      return '<tr>' +
        '<td>' + escapeHtml(project.id) + '</td>' +
        '<td>' + escapeHtml(project.name) + '</td>' +
        '<td>' + escapeHtml(project.parent) + '</td>' +
        '<td>' + escapeHtml(project.site || 'Parent / No Site') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="4">No generated Projects found yet.</td></tr>';
    var taskStatus = getTaskProgressStatus(
      progress.expectedTasks,
      progress.createdTasks,
      progress.taskErrorCount,
      progress.blockedTaskCount
    );
    var taskHierarchy = buildTaskHierarchyHtml(progress.projects, progress.tasks);
    var salesOrderStatus = getSalesOrderProgressStatus(
      progress.expectedSalesOrders,
      progress.createdSalesOrders,
      progress.salesOrderErrorCount,
      progress.blockedSalesOrderCount
    );
    var salesOrderRows = progress.salesOrders.length ? progress.salesOrders.map(function (salesOrder) {
      return '<tr>' +
        '<td>' + escapeHtml(salesOrder.id) + '</td>' +
        '<td>' + escapeHtml(salesOrder.tranid) + '</td>' +
        '<td>' + escapeHtml(salesOrder.status) + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="3">No generated Sales Orders found yet.</td></tr>';
    var errorRows = progress.errors.length ? progress.errors.map(function (err) {
      return '<tr>' +
        '<td>' + escapeHtml(err.type || 'Error') + '</td>' +
        '<td>' + escapeHtml(err.label || '') + '</td>' +
        '<td>' + escapeHtml(err.siteText || err.siteId || (err.lineRef ? 'Line ' + err.lineRef : '')) + '</td>' +
        '<td>' + escapeHtml(err.message || '') + '</td>' +
        '<td>' + (err.retryable === false ? '<span class="muted">Blocked</span>' : '<button type="button" class="mini" data-retry-button="T" onclick="bcRetryOne(\'' + escapeJs(err.key || '') + '\', this)">Retry</button>') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5">No saved errors found.</td></tr>';
    var retryAllButton = progress.errors.length ?
      '<button type="button" class="primary" data-retry-button="T" onclick="bcRetryAll(this)">Retry Failed / Blocked</button>' : '';
    var retryRemainingButton = shouldShowRetryRemaining(progress) ?
      '<button type="button" class="primary secondary-action" data-retry-button="T" onclick="bcRetryRemaining(this)">Retry Remaining</button>' : '';
    var retryStatus = progress.errors.length || shouldShowRetryRemaining(progress) ?
      '<div id="bc_retry_status" class="retry-status idle"></div>' : '';

    return '<!doctype html>' +
      '<html><head><title>Project Progress</title>' +
      '<style>' +
      'body{font-family:Arial,sans-serif;margin:8px;color:#1f2937;background:#f8fafc;font-size:12px;}' +
      '.wrap{max-width:760px;margin:0 auto;background:#fff;border:1px solid #d9e2ec;padding:10px;border-radius:6px;}' +
      'h2{font-size:16px;margin:0 0 4px;}h3{font-size:13px;margin:14px 0 6px;}h4{font-size:12px;margin:10px 0 4px;}' +
      '.bar{height:9px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin:8px 0;}' +
      '.fill{height:9px;background:' + getBarColor(progress.statusCode) + ';width:' + progress.totalPercent + '%;}' +
      '.summary{display:grid;grid-template-columns:repeat(5,minmax(92px,1fr));gap:6px;margin:8px 0 10px;}' +
      '.box{border:1px solid #e5e7eb;background:#f9fafb;padding:7px;border-radius:4px;}' +
      '.label{font-size:10px;color:#6b7280;text-transform:uppercase;}' +
      '.value{font-size:15px;font-weight:700;margin-top:2px;word-break:break-word;}' +
      '.warn{border:1px solid #f59e0b;background:#fffbeb;color:#92400e;padding:8px;margin:8px 0;border-radius:4px;}' +
      'table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px;}' +
      'th,td{border:1px solid #e5e7eb;padding:5px;text-align:left;vertical-align:top;}' +
      'th{background:#f3f4f6;}' +
      '.actions{display:flex;justify-content:flex-end;gap:8px;margin:8px 0;}' +
      '.primary,.mini{border:1px solid #2563eb;background:#2563eb;color:#fff;padding:5px 9px;border-radius:4px;cursor:pointer;font-size:12px;}' +
      '.secondary-action{background:#fff;color:#2563eb;}' +
      '.primary:disabled,.mini:disabled{opacity:.68;cursor:wait;}' +
      '.mini{padding:3px 7px;font-size:11px;}' +
      '.muted{color:#6b7280;font-size:11px;}' +
      '.retry-status{display:none;margin:8px 0;padding:7px 8px;border-radius:4px;font-weight:700;}' +
      '.retry-status.working{display:block;border:1px solid #93c5fd;background:#eff6ff;color:#1d4ed8;}' +
      '.retry-status.success{display:block;border:1px solid #86efac;background:#f0fdf4;color:#047857;}' +
      '.retry-status.warning{display:block;border:1px solid #fbbf24;background:#fffbeb;color:#92400e;}' +
      '.retry-status.error{display:block;border:1px solid #fca5a5;background:#fef2f2;color:#b91c1c;}' +
      '.retrying-row{background:#eff6ff;}' +
      '</style></head><body><div class="wrap">' +
      buildProjectProgressClientScript() +
      '<h2>Generation Progress</h2>' +
      '<div>Estimate: ' + escapeHtml(progress.estimateTranId || progress.estimateId) + '</div>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<div>Overall generated: <strong>' + progress.createdTotal + '</strong> of <strong>' + progress.expectedTotal + '</strong> (' + progress.totalPercent + '%)</div>' +
      warning +
      '<h3>Overall Progress</h3>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Flow</div><div class="value">' + escapeHtml(getEstimateTypeLabel(progress.estimateType)) + '</div></div>' +
        '<div class="box"><div class="label">Expected</div><div class="value">' + progress.expectedTotal + '</div></div>' +
        '<div class="box"><div class="label">Created</div><div class="value">' + progress.createdTotal + '</div></div>' +
        '<div class="box"><div class="label">Remaining</div><div class="value">' + progress.remainingTotal + '</div></div>' +
        '<div class="box"><div class="label">Status</div><div class="value">' + escapeHtml(progress.statusText) + '</div></div>' +
      '</div>' +
      '<div class="actions">' + retryRemainingButton + retryAllButton + '</div>' +
      retryStatus +
      '<h3>Saved Errors / Blockers</h3>' +
      '<table><thead><tr><th>Type</th><th>Attempt</th><th>Site / Line</th><th>Message</th><th>Action</th></tr></thead><tbody>' + errorRows + '</tbody></table>' +
      '<h3>Project Progress</h3>' +
      '<div class="bar"><div class="fill" style="background:' + getCountBarColor(progress.expected, progress.created) + ';width:' + progress.percent + '%;"></div></div>' +
      '<div>Projects created: <strong>' + progress.created + '</strong> of <strong>' + progress.expected + '</strong> (' + progress.percent + '%)</div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Expected Projects</div><div class="value">' + progress.expected + '</div></div>' +
        '<div class="box"><div class="label">Created Projects</div><div class="value">' + progress.created + '</div></div>' +
        '<div class="box"><div class="label">Remaining Projects</div><div class="value">' + progress.remaining + '</div></div>' +
        '<div class="box"><div class="label">Project Source</div><div class="value">Estimate</div></div>' +
      '</div>' +
      '<h3>Project Task Progress</h3>' +
      '<div class="bar"><div class="fill" style="background:' + getTaskBarColor(progress.expectedTasks, progress.createdTasks, progress.taskErrorCount, progress.blockedTaskCount) + ';width:' + progress.taskPercent + '%;"></div></div>' +
      '<div>Project Tasks created: <strong>' + progress.createdTasks + '</strong> of <strong>' + progress.expectedTasks + '</strong> (' + progress.taskPercent + '%)</div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Expected Tasks</div><div class="value">' + progress.expectedTasks + '</div></div>' +
        '<div class="box"><div class="label">Created Tasks</div><div class="value">' + progress.createdTasks + '</div></div>' +
        '<div class="box"><div class="label">Remaining Tasks</div><div class="value">' + progress.remainingTasks + '</div></div>' +
        '<div class="box"><div class="label">Task Status</div><div class="value">' + escapeHtml(taskStatus) + '</div></div>' +
        '<div class="box"><div class="label">Task Source</div><div class="value">CPQ</div></div>' +
      '</div>' +
      '<h3>Sales Order Progress</h3>' +
      '<div class="bar"><div class="fill" style="background:' + getSalesOrderBarColor(progress.expectedSalesOrders, progress.createdSalesOrders, progress.salesOrderErrorCount, progress.blockedSalesOrderCount) + ';width:' + progress.salesOrderPercent + '%;"></div></div>' +
      '<div>Sales Orders created: <strong>' + progress.createdSalesOrders + '</strong> of <strong>' + progress.expectedSalesOrders + '</strong> (' + progress.salesOrderPercent + '%)</div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Expected SO</div><div class="value">' + progress.expectedSalesOrders + '</div></div>' +
        '<div class="box"><div class="label">Created SO</div><div class="value">' + progress.createdSalesOrders + '</div></div>' +
        '<div class="box"><div class="label">Remaining SO</div><div class="value">' + progress.remainingSalesOrders + '</div></div>' +
        '<div class="box"><div class="label">SO Status</div><div class="value">' + escapeHtml(salesOrderStatus) + '</div></div>' +
        '<div class="box"><div class="label">SO Source</div><div class="value">Estimate</div></div>' +
      '</div>' +
      '<h3>Generated Projects</h3>' +
      '<table><thead><tr><th>Internal ID</th><th>Name / ID</th><th>Parent</th><th>Site</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<h3>Generated Sales Orders</h3>' +
      '<table><thead><tr><th>Internal ID</th><th>Document #</th><th>Status</th></tr></thead><tbody>' + salesOrderRows + '</tbody></table>' +
      '<h3>Project Task Hierarchy</h3>' +
      taskHierarchy +
      '<p style="color:#6b7280;margin-top:10px;">Use Refresh Progress to load the latest values. Auto-refresh is paused so scrolling stays stable.</p>' +
      '</div></body></html>';
  }

  function buildInlineProjectProgressHtml(progress) {
    var status = getInlineProjectProgressStatus(progress);
    var label = getEstimateTypeLabel(progress.estimateType);
    var issueCount = progress.errors && progress.errors.length ? progress.errors.length : 0;

    return '' +
      '<div id="bc_inline_project_progress" style="margin:8px 0 10px 0;padding:8px 10px;border:1px solid #d9e2ec;background:#f8fafc;max-width:760px;font-family:Arial,sans-serif;border-radius:4px;">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<div style="flex:1;min-width:240px;">' +
            '<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:5px;font-size:12px;">' +
              '<div style="font-weight:700;color:#1f2937;">Generation Progress</div>' +
              '<div style="color:#4b5563;">' + escapeHtml(label) + '</div>' +
            '</div>' +
            '<div style="height:9px;background:#e5e7eb;border-radius:5px;overflow:hidden;">' +
              '<div style="height:9px;width:' + progress.totalPercent + '%;background:' + getBarColor(progress.statusCode) + ';"></div>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;gap:12px;margin-top:5px;color:#374151;font-size:12px;">' +
              '<div>' + escapeHtml(status) + '</div>' +
              '<div>Total: ' + progress.createdTotal + ' of ' + progress.expectedTotal + ' | Remaining: ' + progress.remainingTotal + '</div>' +
            '</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;color:#4b5563;font-size:11px;">' +
              '<span>Projects: ' + progress.created + '/' + progress.expected + '</span>' +
              '<span>Tasks: ' + progress.createdTasks + '/' + progress.expectedTasks + '</span>' +
              '<span>Sales Orders: ' + progress.createdSalesOrders + '/' + progress.expectedSalesOrders + '</span>' +
              (issueCount ? '<span>Issues: ' + issueCount + '</span>' : '') +
            '</div>' +
          '</div>' +
          '<button type="button" onclick="bcRefreshInlineProjectProgress(this);" style="border:1px solid #9ca3af;background:#fff;color:#1f2937;padding:5px 10px;cursor:pointer;white-space:nowrap;border-radius:4px;font-size:12px;">Refresh</button>' +
          '<button type="button" onclick="bcViewProjectProgress();" style="border:1px solid #9ca3af;background:#fff;color:#1f2937;padding:5px 10px;cursor:pointer;white-space:nowrap;border-radius:4px;font-size:12px;">Show Progress</button>' +
          '<button type="button" title="Close" onclick="var el=document.getElementById(\'bc_inline_project_progress\');if(el){el.style.display=\'none\';}" style="border:1px solid #cbd5e1;background:#fff;color:#1f2937;width:24px;height:24px;cursor:pointer;border-radius:4px;font-weight:700;">x</button>' +
        '</div>' +
      '</div>';
  }

  function getInlineProjectProgressStatus(progress) {
    if (progress.statusCode === 'FAILED') return 'Generation failed. Open progress for details and retry options.';
    if (progress.generationStatus === GEN_STATUS.RETRY_PENDING) return 'Retry is pending background processing';
    if (progress.generationStatus === GEN_STATUS.PENDING) return 'Generation is pending background processing';
    if (progress.generationStatus === GEN_STATUS.PARTIAL_ERROR || (progress.statusCode === 'WARNING' && progress.errors && progress.errors.length)) return 'Generation has errors. Open progress for details and retry options.';
    if (progress.statusCode === 'WARNING') return 'Generated flag set, but generated record count does not match';
    if (progress.statusCode === 'COMPLETE') return 'Generation complete';
    if (!progress.expectedTotal) return 'Waiting for generation criteria';
    if (progress.createdTotal > 0 || isGenerationStatusStarted(progress.generationStatus)) return 'Generation in progress';
    return 'Not started';
  }

  function isGenerationStatusStarted(status) {
    return status === GEN_STATUS.PENDING ||
      status === GEN_STATUS.PROCESSING ||
      status === GEN_STATUS.FAILED ||
      status === GEN_STATUS.PARTIAL_ERROR ||
      status === GEN_STATUS.RETRY_PENDING;
  }

  function buildTaskHierarchyHtml(projects, tasks) {
    if (!tasks.length) {
      return '<div class="box">No generated Project Tasks found yet.</div>';
    }

    var tasksByProject = {};
    for (var t = 0; t < tasks.length; t++) {
      var key = String(tasks[t].projectId || 'unassigned');
      if (!tasksByProject[key]) tasksByProject[key] = [];
      tasksByProject[key].push(tasks[t]);
    }

    var html = '';
    for (var p = 0; p < projects.length; p++) {
      var project = projects[p];
      var projectTasks = tasksByProject[String(project.id)] || [];
      html += '<h4 style="margin-bottom:6px;">' + escapeHtml(project.name || project.id) + '</h4>';

      if (!projectTasks.length) {
        html += '<div class="box" style="margin-bottom:12px;">No Project Tasks found for this Project.</div>';
        continue;
      }

      html += buildTaskTable(projectTasks);
    }

    if (tasksByProject.unassigned) {
      html += '<h4 style="margin-bottom:6px;">Unassigned / Unknown Project</h4>' + buildTaskTable(tasksByProject.unassigned);
    }

    return html;
  }

  function buildTaskTable(tasks) {
    var rows = tasks.map(function (task) {
      return '<tr>' +
        '<td>' + escapeHtml(task.id) + '</td>' +
        '<td>' + escapeHtml(task.title) + '</td>' +
        '<td>' + escapeHtml(task.status) + '</td>' +
        '<td>' + escapeHtml(task.plannedwork) + '</td>' +
      '</tr>';
    }).join('');

    return '<table style="margin-top:0;margin-bottom:14px;"><thead><tr><th>Task ID</th><th>Task Name</th><th>Status</th><th>Planned Work</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function getTaskProgressStatus(expected, created, errorCount, blockedCount) {
    if (!expected) return 'No Tasks Expected';
    if (errorCount > 0 && created > 0) return 'Partial Error';
    if (errorCount > 0) return 'Failed';
    if (blockedCount > 0 && created > 0) return 'Partial Error / Blocked';
    if (blockedCount > 0) return 'Blocked';
    if (created >= expected) return 'Complete';
    if (created > 0) return 'Processing / Partial';
    return 'Not Started';
  }

  function getCountBarColor(expected, created) {
    if (!expected) return '#94a3b8';
    if (created >= expected) return '#059669';
    if (created > 0) return '#2563eb';
    return '#94a3b8';
  }

  function getTaskBarColor(expected, created, errorCount, blockedCount) {
    if (!expected) return '#94a3b8';
    if (errorCount > 0 && created === 0) return '#dc2626';
    if (errorCount > 0 || blockedCount > 0) return '#d97706';
    if (created >= expected) return '#059669';
    if (created > 0) return '#2563eb';
    return '#94a3b8';
  }

  function getSalesOrderProgressStatus(expected, created, errorCount, blockedCount) {
    if (!expected) return 'No Sales Orders Expected';
    if (errorCount > 0 && created > 0) return 'Partial Error';
    if (errorCount > 0) return 'Failed';
    if (blockedCount > 0 && created > 0) return 'Partial Error / Blocked';
    if (blockedCount > 0) return 'Blocked';
    if (created >= expected) return 'Complete';
    if (created > 0) return 'Processing / Partial';
    return 'Not Started';
  }

  function getSalesOrderBarColor(expected, created, errorCount, blockedCount) {
    if (!expected) return '#94a3b8';
    if (errorCount > 0 && created === 0) return '#dc2626';
    if (errorCount > 0 || blockedCount > 0) return '#d97706';
    if (created >= expected) return '#059669';
    if (created > 0) return '#2563eb';
    return '#94a3b8';
  }

  function getProjectProgressStatusDetails(progress) {
    if (progress.generationStatus) {
      if (progress.generationStatus === GEN_STATUS.COMPLETED) return { code: 'COMPLETE', text: 'Completed' };
      if (progress.generationStatus === GEN_STATUS.FAILED) return { code: 'FAILED', text: 'Failed' };
      if (progress.generationStatus === GEN_STATUS.PARTIAL_ERROR) return { code: 'WARNING', text: 'Partial Error' };
      if (progress.generationStatus === GEN_STATUS.RETRY_PENDING) return { code: 'WARNING', text: 'Retry Pending' };
      if (progress.generationStatus === GEN_STATUS.PENDING) return { code: 'PROCESSING', text: 'Pending' };
      if (progress.generationStatus === GEN_STATUS.PROCESSING) return { code: 'PROCESSING', text: 'Processing' };
    }

    if (progress.errorCount > 0) return { code: 'WARNING', text: 'Needs Review' };
    if (!progress.expectedTotal) return { code: 'WAITING', text: 'Waiting' };
    if (progress.generated && progress.createdTotal >= progress.expectedTotal) return { code: 'COMPLETE', text: 'Complete' };
    if (progress.generated && progress.createdTotal < progress.expectedTotal) return { code: 'WARNING', text: 'Warning' };
    if (progress.createdTotal > 0) return { code: 'PROCESSING', text: 'Processing / Partial' };
    return { code: 'NOT_STARTED', text: 'Not Started' };
  }

  function shouldShowRetryRemaining(progress) {
    if (progress.estimateType !== ESTIMATE_TYPE_ROLLOUT) return false;
    if (progress.generated && progress.createdTotal >= progress.expectedTotal) return false;
    return progress.expectedTotal > 0;
  }

  function getBarColor(statusCode) {
    if (statusCode === 'COMPLETE') return '#059669';
    if (statusCode === 'WARNING') return '#d97706';
    if (statusCode === 'FAILED') return '#dc2626';
    if (statusCode === 'PROCESSING') return '#2563eb';
    return '#94a3b8';
  }

  function getEstimateTypeLabel(value) {
    if (value === ESTIMATE_TYPE_STANDARD) return 'Standard';
    if (value === ESTIMATE_TYPE_ROLLOUT) return 'Rollout';
    return 'Missing';
  }

  function getGenerationStatusLabel(value) {
    return GEN_STATUS_LABEL[String(value || '')] || '';
  }

  function readGenerationErrorDetails(est) {
    var raw = est.getValue(EST.ERROR_DETAILS);
    if (!raw) return { errors: [], warnings: [], updatedAt: '' };

    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { errors: parsed, warnings: [], updatedAt: '' };
      }

      return {
        errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        updatedAt: parsed.updatedAt || ''
      };
    } catch (e) {
      return {
        errors: [{
          key: 'error-details-json',
          type: 'Progress',
          label: 'Saved Error Details',
          message: 'Could not parse saved error detail JSON: ' + (e.message || String(e)),
          retryable: false
        }],
        warnings: [],
        updatedAt: ''
      };
    }
  }

  function setGenerationStatus(estId, statusValue, opts) {
    var values = {};
    values[EST.GENERATION_STATUS] = statusValue;

    opts = opts || {};
    if (opts.projectId !== undefined && opts.projectId !== null && opts.projectId !== '') {
      values[EST.GENERATED_PROJECT] = opts.projectId;
    }
    if (opts.generated !== undefined) values[EST.PROJECT_GENERATED] = opts.generated === true;
    if (opts.errorDetails !== undefined) {
      values[EST.ERROR_DETAILS] = opts.errorDetails ? JSON.stringify(opts.errorDetails) : '';
    }

    record.submitFields({
      type: record.Type.ESTIMATE,
      id: estId,
      values: values,
      options: {
        enableSourcing: false,
        ignoreMandatoryFields: true
      }
    });
  }

  function markGenerationProcessing(estId) {
    setGenerationStatus(estId, GEN_STATUS.PROCESSING, { generated: false });
  }

  function persistGenerationErrors(estId, errors, warnings, statusValue) {
    setGenerationStatus(estId, statusValue, {
      generated: false,
      errorDetails: {
        updatedAt: new Date().toISOString(),
        errors: normalizeGenerationErrors(errors),
        warnings: warnings || []
      }
    });
  }

  function persistUnhandledGenerationFailure(estId, action, error) {
    if (!estId || action === 'progress' || action === 'inline_progress') return;

    var est = record.load({
      type: record.Type.ESTIMATE,
      id: estId,
      isDynamic: false
    });
    var currentStatus = String(est.getValue(EST.GENERATION_STATUS) || '');

    if (!isActiveGenerationStatus(currentStatus)) return;

    var detail = readGenerationErrorDetails(est);
    var errors = (detail.errors || []).slice();
    errors.push({
      key: 'generation:unhandled:' + new Date().getTime(),
      type: 'Generation',
      label: getGenerationActionLabel(action),
      retryable: true,
      message: error && error.message ? error.message : String(error)
    });

    var anyCreated = getGeneratedProjects(estId).length > 0 ||
      getGeneratedProjectTasks(estId).length > 0 ||
      getGeneratedSalesOrders(estId).length > 0;

    persistGenerationErrors(
      estId,
      errors,
      detail.warnings || [],
      anyCreated ? GEN_STATUS.PARTIAL_ERROR : GEN_STATUS.FAILED
    );
  }

  function isActiveGenerationStatus(status) {
    return status === GEN_STATUS.PROCESSING ||
      status === GEN_STATUS.PENDING ||
      status === GEN_STATUS.RETRY_PENDING;
  }

  function getGenerationActionLabel(action) {
    if (action === 'retry') return 'Retry';
    if (action === 'retry_all') return 'Retry Failed / Blocked';
    if (action === 'retry_remaining') return 'Retry Remaining';
    return 'Generate Project / Sales Order';
  }

  function clearGenerationErrors(estId, projectId) {
    setGenerationStatus(estId, GEN_STATUS.COMPLETED, {
      projectId: projectId,
      generated: true,
      errorDetails: null
    });
  }

  function normalizeGenerationErrors(errors) {
    var normalized = [];
    var seen = {};

    for (var i = 0; i < (errors || []).length; i++) {
      var err = errors[i] || {};
      var key = err.key || makeFallbackErrorKey(err, i);

      if (seen[key]) {
        seen[key].message = err.message || seen[key].message;
        continue;
      }

      seen[key] = {
        key: key,
        type: err.type || 'Generation',
        label: err.label || '',
        siteId: err.siteId || '',
        siteText: err.siteText || '',
        lineRef: err.lineRef || '',
        stagingId: err.stagingId || '',
        taskIndex: err.taskIndex || '',
        projectId: err.projectId || '',
        salesOrderId: err.salesOrderId || '',
        blockedBy: err.blockedBy || '',
        retryable: err.retryable !== false,
        message: err.message || ''
      };
      normalized.push(seen[key]);
    }

    return normalized;
  }

  function makeFallbackErrorKey(err, index) {
    return [
      err.type || 'generation',
      err.siteId || err.lineRef || '',
      err.stagingId || '',
      err.taskIndex || '',
      index
    ].join(':');
  }

  function findSavedError(est, key) {
    var detail = readGenerationErrorDetails(est);
    for (var i = 0; i < detail.errors.length; i++) {
      if (String(detail.errors[i].key || '') === String(key || '')) return detail.errors[i];
    }
    return null;
  }

  function validateEstimate(est, estId, opts) {
    opts = opts || {};

    if (String(est.getValue(EST.APPROVAL_STATUS)) !== APPROVED_STATUS_VALUE) {
      throw new Error('Estimate is not in customer-approved status.');
    }

    if (!opts.allowCompleted && est.getValue(EST.PROJECT_GENERATED) === true) {
      throw new Error('Project already generated for this estimate.');
    }

    if (!opts.allowExistingGeneratedRecords && hasExistingGeneratedProjects(estId)) {
      throw new Error('Project records already exist for this estimate. Delete or review them before re-running.');
    }

    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');
    var missingFields = [];

    if (isMissing(est.getValue(EST.PROJECT_START))) missingFields.push('Project Start Date');
    if (isMissing(est.getValue(EST.PROJECT_END))) missingFields.push('Estimated End Date');
    if (isMissing(est.getValue(EST.PROJECTMANAGER))) missingFields.push('Project Manager');
    if (estimateType === ESTIMATE_TYPE_STANDARD && isMissing(est.getValue(EST.SITE_ASSET))) {
      missingFields.push('Site Asset');
    }

    if (missingFields.length) {
      throw new Error(
        'Please populate the following required field(s) before generating Project and Sales Order: ' +
        missingFields.join(', ') +
        '. Then try again.'
      );
    }
  }

  function runStandardProjectCreation(est, estId) {
    markGenerationProcessing(estId);

    var expectedRecordCount = getExpectedStandardRecordCount(est, estId);
    if (expectedRecordCount > STANDARD_ASYNC_RECORD_THRESHOLD) {
      return startStandardBackgroundGeneration(est, estId, expectedRecordCount);
    }

    return runStandardGenerationFlow(est, estId, { initialRun: true });
  }

  function getExpectedStandardRecordCount(est, estId) {
    return 1 + getExpectedProjectTaskCount(est, estId) + 1;
  }

  function startStandardBackgroundGeneration(est, estId, expectedRecordCount) {
    var expectedTaskCount = getExpectedProjectTaskCount(est, estId);
    var errors = [];
    var projectId = findExistingStandardProject(estId);

    if (!projectId) {
      var projectResult = tryCreateProject({
        estimate: est,
        estimateId: estId,
        parentId: est.getValue(EST.ENTITY),
        siteAssetId: est.getValue(EST.SITE_ASSET),
        namePrefix: 'Project',
        attemptLabel: 'Standard Project',
        errorType: 'Project',
        errorKey: 'project:standard'
      });

      if (projectResult.projectId) projectId = projectResult.projectId;
      if (projectResult.error) errors.push(projectResult.error);
    }

    if (errors.length || !projectId) {
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'STANDARD',
        expectedProjectCount: 1,
        expectedTaskCount: expectedTaskCount,
        projectIds: projectId ? [projectId] : [],
        projectErrors: errors,
        note: 'Standard Project could not be created. Background Project Task and Sales Order processing did not start.'
      });
    }

    setGenerationStatus(estId, GEN_STATUS.PENDING, {
      projectId: projectId,
      generated: false
    });

    var submitResult = submitRolloutMapReduce(estId, ROLLOUT_MR_DEPLOY_NOW);
    if (submitResult.submitted) {
      setGenerationStatus(estId, GEN_STATUS.PROCESSING, {
        projectId: projectId,
        generated: false
      });
    }

    return {
      success: true,
      async: true,
      flowType: 'STANDARD',
      projectId: projectId,
      projectIds: [projectId],
      expectedProjectCount: 1,
      projectCount: 1,
      expectedTaskCount: expectedTaskCount,
      expectedSalesOrderCount: 1,
      expectedRecordCount: expectedRecordCount,
      taskId: submitResult.taskId || '',
      queued: !submitResult.submitted,
      note: submitResult.submitted ?
        'Standard Project is ready and background Project Task/Sales Order processing has started.' :
        'Standard Project is ready. The on-demand Map/Reduce deployment was busy, so the scheduled deployment will pick this up.'
    };
  }

  function runStandardGenerationFlow(est, estId, opts) {
    opts = opts || {};
    var projectIds = [];
    var errors = [];
    var projectId = findExistingStandardProject(estId);

    if (projectId) {
      projectIds.push(projectId);
    } else {
      var result = tryCreateProject({
        estimate: est,
        estimateId: estId,
        parentId: est.getValue(EST.ENTITY),
        siteAssetId: est.getValue(EST.SITE_ASSET),
        namePrefix: 'Project',
        attemptLabel: 'Standard Project',
        errorType: 'Project',
        errorKey: 'project:standard'
      });

      if (result.projectId) projectIds.push(result.projectId);
      if (result.projectId) projectId = result.projectId;
      if (result.error) errors.push(result.error);
    }

    if (errors.length) {
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'STANDARD',
        expectedProjectCount: 1,
        projectIds: projectIds,
        projectErrors: errors,
        note: 'Standard Project generation completed with errors. Review the failed attempts, fix the data, and re-run as needed.'
      });
    }

    var taskResult = createProjectTasksForEstimate(est, estId, function () {
      return projectId;
    });

    if (taskResult.errors.length) {
      var taskRollback = rollbackGeneratedProject(estId, projectId, {
        reason: 'Standard Project Task generation failed.'
      });
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'STANDARD',
        expectedProjectCount: 1,
        expectedTaskCount: taskResult.expectedTaskCount,
        projectIds: taskRollback.success ? [] : projectIds,
        taskIds: taskRollback.success ? [] : taskResult.taskIds,
        taskErrors: taskResult.errors.concat(taskRollback.errors),
        warnings: (taskResult.warnings || []).concat(taskRollback.warnings),
        note: taskRollback.success ?
          'Standard Project Task generation failed. The related Project was rolled back.' :
          'Standard Project Task generation failed, and rollback could not delete all generated records.'
      });
    }

    var salesOrderResult;
    try {
      salesOrderResult = createStandardSalesOrderFromEstimate(estId, projectId);
    } catch (salesOrderError) {
      var salesOrderRollback = rollbackGeneratedProject(estId, projectId, {
        reason: 'Standard Sales Order generation failed.',
        salesOrderId: salesOrderError.salesOrderId || ''
      });
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'STANDARD',
        expectedProjectCount: 1,
        expectedTaskCount: taskResult.expectedTaskCount,
        projectIds: salesOrderRollback.success ? [] : projectIds,
        taskIds: salesOrderRollback.success ? [] : taskResult.taskIds,
        salesOrderIds: salesOrderRollback.success ? [] : (salesOrderError.salesOrderId ? [salesOrderError.salesOrderId] : []),
        salesOrderErrors: [makeSalesOrderError('Standard Sales Order', salesOrderError.message || String(salesOrderError), {
          key: 'so:standard'
        })].concat(salesOrderRollback.errors),
        warnings: (taskResult.warnings || []).concat(salesOrderRollback.warnings),
        note: salesOrderRollback.success ?
          'Standard Sales Order generation failed. The related Project was rolled back.' :
          'Standard Sales Order generation failed, and rollback could not delete all generated records.'
      });
    }

    markEstimateGenerated(estId, projectId);

    return {
      success: true,
      flowType: 'STANDARD',
      projectId: projectId,
      projectIds: projectIds,
      projectCount: projectIds.length,
      expectedTaskCount: taskResult.expectedTaskCount,
      taskCount: taskResult.taskIds.length,
      taskIds: taskResult.taskIds,
      salesOrderId: salesOrderResult.salesOrderId,
      salesOrderIds: [salesOrderResult.salesOrderId],
      salesOrderCount: 1,
      estimateLinesUpdated: salesOrderResult.estimateLinesUpdated,
      warnings: taskResult.warnings,
      note: 'Standard Project, Project Tasks, and Sales Order created.'
    };
  }

  function runRolloutProjectCreation(est, estId) {
    markGenerationProcessing(estId);
    var sites = getUniqueLineSites(est);
    if (!sites.length) {
      throw new Error('Rollout Estimate has no unique line-level Site Assets in ' + EST_LINE.SITE_ASSET + '.');
    }

    if (sites.length >= ROLLOUT_ASYNC_SITE_THRESHOLD) {
      return startRolloutBackgroundGeneration(est, estId, sites);
    }

    return runRolloutGenerationFlow(est, estId, sites, { initialRun: true });
  }

  function startRolloutBackgroundGeneration(est, estId, sites) {
    var errors = [];
    var parentProjectId = findExistingRolloutParentProject(est, estId);

    if (!parentProjectId) {
      var parentResult = tryCreateProject({
        estimate: est,
        estimateId: estId,
        parentId: est.getValue(EST.ENTITY),
        siteAssetId: null,
        namePrefix: 'Rollout Parent',
        attemptLabel: 'Rollout Parent Project',
        errorType: 'Project',
        errorKey: 'project:rollout-parent'
      });

      if (parentResult.projectId) parentProjectId = parentResult.projectId;
      if (parentResult.error) errors.push(parentResult.error);
    }

    if (errors.length || !parentProjectId) {
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'ROLLOUT',
        expectedProjectCount: sites.length + 1,
        projectIds: parentProjectId ? [parentProjectId] : [],
        projectErrors: errors,
        siteCount: sites.length,
        note: 'Rollout parent Project could not be created. Child Project, Project Task, and Sales Order processing did not start.'
      });
    }

    setGenerationStatus(estId, GEN_STATUS.PENDING, {
      projectId: parentProjectId,
      generated: false
    });

    var submitResult = submitRolloutMapReduce(estId, ROLLOUT_MR_DEPLOY_NOW);
    if (submitResult.submitted) {
      setGenerationStatus(estId, GEN_STATUS.PROCESSING, {
        projectId: parentProjectId,
        generated: false
      });
    }

    return {
      success: true,
      async: true,
      flowType: 'ROLLOUT',
      parentProjectId: parentProjectId,
      siteCount: sites.length,
      expectedProjectCount: sites.length + 1,
      projectCount: 1,
      taskId: submitResult.taskId || '',
      queued: !submitResult.submitted,
      note: submitResult.submitted ?
        'Rollout parent Project is ready and background processing has started.' :
        'Rollout parent Project is ready. The on-demand Map/Reduce deployment was busy, so the scheduled deployment will pick this up.'
    };
  }

  function submitRolloutMapReduce(estId, deploymentId) {
    try {
      var params = {};
      params[MR_PARAM_ESTIMATE_ID] = String(estId);
      var mrTask = taskModule.create({
        taskType: taskModule.TaskType.MAP_REDUCE,
        scriptId: ROLLOUT_MR_SCRIPT_ID,
        deploymentId: deploymentId,
        params: params
      });

      return {
        submitted: true,
        taskId: mrTask.submit()
      };
    } catch (e) {
      log.audit({
        title: 'BC Rollout Map/Reduce submit deferred',
        details: JSON.stringify({
          estimateId: estId,
          scriptId: ROLLOUT_MR_SCRIPT_ID,
          deploymentId: deploymentId,
          error: getErrorDetails(e)
        })
      });

      return {
        submitted: false,
        error: e.message || String(e)
      };
    }
  }

  function retryGenerationItem(est, estId, key) {
    validateEstimate(est, estId, {
      allowExistingGeneratedRecords: true,
      allowCompleted: true
    });

    if (!key) throw new Error('Missing retry key.');

    var savedError = findSavedError(est, key);
    if (!savedError) throw new Error('The selected retry item was not found in saved progress details.');

    setGenerationStatus(estId, GEN_STATUS.PROCESSING, { generated: false });

    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');
    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      var retryRecordCount = getExpectedStandardRecordCount(est, estId);
      if (retryRecordCount > STANDARD_ASYNC_RECORD_THRESHOLD) {
        return startStandardBackgroundGeneration(est, estId, retryRecordCount);
      }
      return runStandardGenerationFlow(est, estId, { retryKey: key });
    }

    if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
      return runRolloutGenerationFlow(est, estId, getRetrySitesForSavedError(est, savedError), {
        retryKey: key,
        retryError: savedError
      });
    }

    throw new Error('Unsupported or missing Estimate Type. Expected Standard (1) or Rollout (2).');
  }

  function getRetrySitesForSavedError(est, savedError) {
    var sites = getUniqueLineSites(est);
    var siteId = savedError && savedError.siteId ? String(savedError.siteId) : '';

    if (!siteId) return sites;

    var retrySites = [];
    for (var i = 0; i < sites.length; i++) {
      if (String(sites[i].id || '') === siteId) {
        retrySites.push(sites[i]);
        break;
      }
    }

    return retrySites.length ? retrySites : sites;
  }

  function retryAllGeneration(est, estId) {
    validateEstimate(est, estId, {
      allowExistingGeneratedRecords: true,
      allowCompleted: true
    });

    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      setGenerationStatus(estId, GEN_STATUS.PROCESSING, { generated: false });
      var retryAllRecordCount = getExpectedStandardRecordCount(est, estId);
      if (retryAllRecordCount > STANDARD_ASYNC_RECORD_THRESHOLD) {
        return startStandardBackgroundGeneration(est, estId, retryAllRecordCount);
      }
      return runStandardGenerationFlow(est, estId, { retryAll: true });
    }

    if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
      return retryRemainingGeneration(est, estId);
    }

    throw new Error('Unsupported or missing Estimate Type. Expected Standard (1) or Rollout (2).');
  }

  function retryRemainingGeneration(est, estId) {
    validateEstimate(est, estId, {
      allowExistingGeneratedRecords: true,
      allowCompleted: true
    });

    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');
    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      setGenerationStatus(estId, GEN_STATUS.PROCESSING, { generated: false });
      var retryRemainingRecordCount = getExpectedStandardRecordCount(est, estId);
      if (retryRemainingRecordCount > STANDARD_ASYNC_RECORD_THRESHOLD) {
        return startStandardBackgroundGeneration(est, estId, retryRemainingRecordCount);
      }
      return runStandardGenerationFlow(est, estId, { retryRemaining: true });
    }

    if (estimateType !== ESTIMATE_TYPE_ROLLOUT) {
      throw new Error('Retry Remaining is only supported for Standard or Rollout estimates.');
    }

    var parentProjectId = findExistingRolloutParentProject(est, estId);
    setGenerationStatus(estId, GEN_STATUS.RETRY_PENDING, {
      projectId: parentProjectId || undefined,
      generated: false
    });

    var submitResult = submitRolloutMapReduce(estId, ROLLOUT_MR_DEPLOY_NOW);
    if (submitResult.submitted) {
      setGenerationStatus(estId, GEN_STATUS.PROCESSING, {
        projectId: parentProjectId || undefined,
        generated: false
      });
    }

    return {
      success: true,
      async: true,
      flowType: 'ROLLOUT',
      taskId: submitResult.taskId || '',
      queued: !submitResult.submitted,
      note: submitResult.submitted ?
        'Retry Remaining was sent to Map/Reduce. It will re-check existing records and create only missing site records.' :
        'Retry Remaining is pending because the on-demand Map/Reduce deployment is busy. The scheduled deployment will pick it up.'
    };
  }

  function runRolloutGenerationFlow(est, estId, sites, opts) {
    opts = opts || {};
    sites = sites || getUniqueLineSites(est);

    var errors = [];
    var parentProjectId = findExistingRolloutParentProject(est, estId);

    if (!parentProjectId) {
      var parentResult = tryCreateProject({
        estimate: est,
        estimateId: estId,
        parentId: est.getValue(EST.ENTITY),
        siteAssetId: null,
        namePrefix: 'Rollout Parent',
        attemptLabel: 'Rollout Parent Project',
        errorType: 'Project',
        errorKey: 'project:rollout-parent'
      });

      if (parentResult.projectId) parentProjectId = parentResult.projectId;
      if (parentResult.error) errors.push(parentResult.error);
    }

    if (parentProjectId) {
      setGenerationStatus(estId, GEN_STATUS.PROCESSING, {
        projectId: parentProjectId,
        generated: false
      });
    }

    var childProjectIds = [];
    var childProjectBySite = getExistingChildProjectsBySite(estId);

    if (parentProjectId) {
      for (var i = 0; i < sites.length; i++) {
        if (childProjectBySite[String(sites[i].id)]) {
          childProjectIds.push(childProjectBySite[String(sites[i].id)]);
          continue;
        }

        var childResult = tryCreateProject({
          estimate: est,
          estimateId: estId,
          parentId: parentProjectId,
          siteAssetId: sites[i].id,
          siteText: sites[i].text,
          namePrefix: 'Rollout Site ' + (sites[i].text || sites[i].id),
          attemptLabel: 'Rollout Child Project for Site ' + (sites[i].text || sites[i].id),
          errorType: 'Project',
          errorKey: 'project:child:' + sites[i].id
        });

        if (childResult.projectId) childProjectIds.push(childResult.projectId);
        if (childResult.projectId) childProjectBySite[String(sites[i].id)] = childResult.projectId;
        if (childResult.error) {
          errors.push(childResult.error);
          errors.push(makeBlockedError({
            key: 'blocked:task:site:' + sites[i].id,
            type: 'Blocked Project Task',
            label: 'Project Tasks for Site ' + (sites[i].text || sites[i].id),
            siteId: sites[i].id,
            siteText: sites[i].text,
            message: 'Blocked because the child Project was not created.',
            blockedBy: childResult.error.key || 'Child Project'
          }));
          errors.push(makeBlockedError({
            key: 'blocked:so:site:' + sites[i].id,
            type: 'Blocked Sales Order',
            label: 'Sales Order for Site ' + (sites[i].text || sites[i].id),
            siteId: sites[i].id,
            siteText: sites[i].text,
            message: 'Blocked because the child Project was not created.',
            blockedBy: childResult.error.key || 'Child Project'
          }));
        }
      }
    } else {
      for (var s = 0; s < sites.length; s++) {
        errors.push({
          key: 'project:child:' + sites[s].id,
          type: 'Project',
          label: 'Rollout Child Project for Site ' + (sites[s].text || sites[s].id),
          siteId: sites[s].id,
          siteText: sites[s].text,
          message: 'Skipped because the parent Project was not created.'
        });
      }
    }

    var taskResult = createProjectTasksForEstimate(est, estId, function (staging, taskData) {
      var siteId = staging.siteAssetId || taskData[TASK.ASSET];
      if (!siteId) throw new Error('No Site Asset found for staging record ' + staging.id + '.');

      var childProjectId = childProjectBySite[String(siteId)];
      if (!childProjectId) throw new Error('No child Project found for Site Asset ' + siteId + '.');

      return childProjectId;
    });

    var taskErrorSites = getErrorSiteMap(taskResult.errors);
    var taskRollback = rollbackSiteProjectsForErrors(estId, childProjectBySite, taskResult.errors, {
      reason: 'Rollout Project Task generation failed.'
    });
    childProjectIds = removeIds(childProjectIds, taskRollback.deletedProjectIds);
    taskResult.taskIds = removeIds(taskResult.taskIds || [], taskRollback.deletedTaskIds);

    var salesOrderSites = filterSitesWithProjects(sites, childProjectBySite);
    var salesOrderResult = createRolloutSalesOrdersFromEstimate(est, estId, salesOrderSites, childProjectBySite, taskErrorSites);
    var salesOrderErrors = salesOrderResult.errors || [];
    var salesOrderRollback = rollbackSiteProjectsForErrors(estId, childProjectBySite, salesOrderErrors, {
      reason: 'Rollout Sales Order generation failed.'
    });
    childProjectIds = removeIds(childProjectIds, salesOrderRollback.deletedProjectIds);
    taskResult.taskIds = removeIds(taskResult.taskIds || [], salesOrderRollback.deletedTaskIds);
    salesOrderResult.salesOrderIds = removeIds(salesOrderResult.salesOrderIds || [], salesOrderRollback.deletedSalesOrderIds);

    if (errors.length || taskResult.errors.length || salesOrderErrors.length) {
      var allProjectIds = parentProjectId ? [parentProjectId].concat(childProjectIds) : childProjectIds;
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'ROLLOUT',
        parentProjectId: parentProjectId,
        childProjectIds: childProjectIds,
        projectIds: allProjectIds,
        expectedProjectCount: sites.length + 1,
        expectedTaskCount: taskResult.expectedTaskCount,
        taskIds: taskResult.taskIds,
        salesOrderIds: salesOrderResult.salesOrderIds,
        projectErrors: errors,
        taskErrors: taskResult.errors.concat(taskRollback.errors),
        salesOrderErrors: salesOrderErrors.concat(salesOrderRollback.errors),
        siteCount: sites.length,
        warnings: (taskResult.warnings || []).concat(taskRollback.warnings).concat(salesOrderRollback.warnings),
        note: 'Rollout generation completed with errors. Failed site child Projects were rolled back; successful sites were left in place.'
      });
    }

    markEstimateGenerated(estId, parentProjectId);

    return {
      success: true,
      flowType: 'ROLLOUT',
      parentProjectId: parentProjectId,
      childProjectIds: childProjectIds,
      siteCount: sites.length,
      projectCount: childProjectIds.length + 1,
      expectedTaskCount: taskResult.expectedTaskCount,
      taskCount: taskResult.taskIds.length,
      taskIds: taskResult.taskIds,
      salesOrderIds: salesOrderResult.salesOrderIds,
      salesOrderCount: salesOrderResult.salesOrderIds.length,
      estimateLinesUpdated: salesOrderResult.estimateLinesUpdated,
      warnings: taskResult.warnings,
      note: 'Rollout parent, child Projects, Project Tasks, and Sales Orders created.'
    };
  }

  function createProject(opts) {
    var est = opts.estimate;
    var project = record.create({ type: record.Type.JOB, isDynamic: true });

    project.setValue({ fieldId: PROJ.CUSTOMER_PARENT, value: opts.parentId });
    project.setValue({ fieldId: PROJ.SUBSIDIARY, value: est.getValue(EST.SUBSIDIARY) });
    project.setValue({ fieldId: PROJ.STARTDATE, value: est.getValue(EST.PROJECT_START) || est.getValue(EST.TRANDATE) });
    project.setValue({ fieldId: PROJ.PROJECTED_END, value: est.getValue(EST.PROJECT_END) });
    project.setValue({ fieldId: PROJ.FS_PROJECT_TYPE, value: FIXED_FEE_PROJECT_TYPE });
    project.setValue({ fieldId: PROJ.SOURCE_ESTIMATE, value: opts.estimateId });

    setIfPresent(project, PROJ.NAME, makeProjectName(opts.namePrefix, est.getValue(EST.TRANID)));
    setIfPresent(project, PROJ.SALESREP, est.getValue(EST.SALESREP));
    setIfPresent(project, PROJ.DEPARTMENT, est.getValue(EST.DEPARTMENT));
    setIfPresent(project, PROJ.CLASS, est.getValue(EST.CLASS));
    setIfPresent(project, PROJ.LOCATION, est.getValue(EST.LOCATION));
    setIfPresent(project, PROJ.PROJECTMANAGER, est.getValue(EST.PROJECTMANAGER));
    setIfPresent(project, PROJ.SITE_ASSET, opts.siteAssetId);

    project.setValue({
      fieldId: PROJ.FS_CUSTOMER,
      value: est.getValue(EST.FSM_CUSTOMER) || est.getValue(EST.ENTITY)
    });

    return project.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  function tryCreateProject(opts) {
    try {
      return {
        projectId: createProject(opts),
        error: null
      };
    } catch (e) {
      var error = {
        key: opts.errorKey || makeFallbackErrorKey({ type: opts.errorType || 'Project', siteId: opts.siteAssetId }, 0),
        type: opts.errorType || 'Project',
        label: opts.attemptLabel || opts.namePrefix || 'Project',
        siteId: opts.siteAssetId || '',
        siteText: opts.siteText || '',
        message: e.message || String(e)
      };

      log.error({
        title: 'BC Project generation failed: ' + error.label,
        details: JSON.stringify(error)
      });

      return {
        projectId: null,
        error: error
      };
    }
  }

  function createStandardSalesOrderFromEstimate(estId, projectId) {
    var salesOrderId;

    try {
      var existingSalesOrderId = findExistingSalesOrderForProject(estId, projectId);
      if (existingSalesOrderId) {
        return {
          salesOrderId: existingSalesOrderId,
          lineProjectCount: 0,
          estimateLinesUpdated: updateEstimateLinesWithSalesOrder(estId, existingSalesOrderId),
          reused: true
        };
      }

      log.audit({
        title: 'BC Sales Order transform started',
        details: JSON.stringify({
          estimateId: estId,
          projectId: projectId,
          flowType: 'STANDARD'
        })
      });

      var estimateLineCpqJsonByLine = getEstimateLineCpqJsonByLine(estId);
      var salesOrder = record.transform({
        fromType: record.Type.ESTIMATE,
        fromId: estId,
        toType: record.Type.SALES_ORDER,
        isDynamic: false
      });

      setSalesOrderExternalId(salesOrder, estId, projectId);
      salesOrder.setValue({ fieldId: SO.PROJECT, value: projectId });
      salesOrder.setValue({ fieldId: SO.SOURCE_ESTIMATE, value: estId });

      var lineCount = salesOrder.getLineCount({ sublistId: 'item' }) || 0;
      var expandedKitCount = expandKitLinesOnSalesOrder(salesOrder, projectId, estimateLineCpqJsonByLine);
      var lineProjectCount = setSalesOrderLineProjects(salesOrder, projectId);

      log.audit({
        title: 'BC Sales Order save attempt',
        details: JSON.stringify({
          estimateId: estId,
          projectId: projectId,
          itemLineCount: lineCount,
          expandedKitCount: expandedKitCount,
          lineProjectCount: lineProjectCount
        })
      });

      salesOrderId = salesOrder.save({
        enableSourcing: true,
        ignoreMandatoryFields: true
      });

      log.audit({
        title: 'BC Sales Order saved',
        details: JSON.stringify({
          estimateId: estId,
          projectId: projectId,
          salesOrderId: salesOrderId
        })
      });

      var estimateLinesUpdated = updateEstimateLinesWithSalesOrder(estId, salesOrderId);

      return {
        salesOrderId: salesOrderId,
        lineProjectCount: lineProjectCount,
        estimateLinesUpdated: estimateLinesUpdated,
        expandedKitCount: expandedKitCount
      };
    } catch (e) {
      log.error({
        title: 'BC Sales Order creation failed',
        details: JSON.stringify({
          estimateId: estId,
          projectId: projectId,
          salesOrderId: salesOrderId || '',
          error: getErrorDetails(e)
        })
      });

      if (salesOrderId) {
        var wrapped = new Error('Sales Order ' + salesOrderId + ' was created, but a later Sales Order/Estimate linkage step failed: ' + (e.message || String(e)));
        wrapped.salesOrderId = salesOrderId;
        throw wrapped;
      }

      var existingAfterError = findExistingSalesOrderForProject(estId, projectId);
      if (existingAfterError) {
        return {
          salesOrderId: existingAfterError,
          lineProjectCount: 0,
          estimateLinesUpdated: updateEstimateLinesWithSalesOrder(estId, existingAfterError),
          reused: true,
          recoveredAfterSaveError: true
        };
      }

      throw e;
    }
  }

  function setSalesOrderLineProjects(salesOrder, projectId) {
    var lineCount = salesOrder.getLineCount({ sublistId: 'item' }) || 0;
    var updated = 0;

    for (var i = 0; i < lineCount; i++) {
      var itemId = salesOrder.getSublistValue({
        sublistId: 'item',
        fieldId: 'item',
        line: i
      });

      if (!itemId) continue;

      salesOrder.setSublistValue({
        sublistId: 'item',
        fieldId: SO.PROJECT,
        line: i,
        value: projectId
      });
      updated++;
    }

    return updated;
  }

  function updateEstimateLinesWithSalesOrder(estId, salesOrderId, siteAssetId) {
    try {
      return updateEstimateLinesWithSalesOrderStatic(estId, salesOrderId, siteAssetId);
    } catch (staticError) {
      log.error({
        title: 'BC Estimate line Sales Order static link failed',
        details: JSON.stringify({
          estimateId: estId,
          salesOrderId: salesOrderId,
          siteAssetId: siteAssetId || '',
          error: getErrorDetails(staticError)
        })
      });
      return updateEstimateLinesWithSalesOrderDynamic(estId, salesOrderId, siteAssetId, staticError);
    }
  }

  function updateEstimateLinesWithSalesOrderStatic(estId, salesOrderId, siteAssetId) {
    var est = record.load({
      type: record.Type.ESTIMATE,
      id: estId,
      isDynamic: false
    });
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;
    var updated = 0;

    for (var i = 0; i < lineCount; i++) {
      if (!shouldAttachSalesOrderToEstimateLine(est, i, siteAssetId)) continue;

      est.setSublistValue({
        sublistId: 'item',
        fieldId: EST_LINE.RELATED_SALES_ORDER,
        line: i,
        value: salesOrderId
      });
      updated++;
    }

    est.save({
      enableSourcing: true,
      ignoreMandatoryFields: true
    });

    log.audit({
      title: 'BC Estimate lines linked to Sales Order',
      details: JSON.stringify({
        estimateId: estId,
        salesOrderId: salesOrderId,
        siteAssetId: siteAssetId || '',
        lineCount: lineCount,
        updatedLineCount: updated,
        fieldId: EST_LINE.RELATED_SALES_ORDER
      })
    });

    return updated;
  }

  function updateEstimateLinesWithSalesOrderDynamic(estId, salesOrderId, siteAssetId, originalError) {
    var est = record.load({
      type: record.Type.ESTIMATE,
      id: estId,
      isDynamic: true
    });
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;
    var updated = 0;
    var lineErrors = [];

    for (var i = 0; i < lineCount; i++) {
      if (!shouldAttachSalesOrderToEstimateLine(est, i, siteAssetId)) continue;

      try {
        est.selectLine({
          sublistId: 'item',
          line: i
        });
        est.setCurrentSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.RELATED_SALES_ORDER,
          value: salesOrderId,
          ignoreFieldChange: true
        });
        est.commitLine({
          sublistId: 'item'
        });
        updated++;
      } catch (lineError) {
        lineErrors.push('Line ' + (i + 1) + ': ' + (lineError.message || String(lineError)));
      }
    }

    if (lineErrors.length) {
      throw new Error(
        'Sales Order ' + salesOrderId + ' was created, but Estimate line linkage failed. ' +
        lineErrors.join(' | ') +
        (originalError ? ' Original error: ' + (originalError.message || String(originalError)) : '')
      );
    }

    est.save({
      enableSourcing: true,
      ignoreMandatoryFields: true
    });

    log.audit({
      title: 'BC Estimate lines linked to Sales Order using dynamic fallback',
      details: JSON.stringify({
        estimateId: estId,
        salesOrderId: salesOrderId,
        siteAssetId: siteAssetId || '',
        lineCount: lineCount,
        updatedLineCount: updated,
        fieldId: EST_LINE.RELATED_SALES_ORDER
      })
    });

    return updated;
  }

  function shouldAttachSalesOrderToEstimateLine(est, line, siteAssetId) {
    var itemId = est.getSublistValue({
      sublistId: 'item',
      fieldId: 'item',
      line: line
    });

    if (!itemId) return false;
    if (!siteAssetId) return true;

    var lineSiteAssetId = est.getSublistValue({
      sublistId: 'item',
      fieldId: EST_LINE.SITE_ASSET,
      line: line
    });

    return String(lineSiteAssetId || '') === String(siteAssetId || '');
  }

  function createRolloutSalesOrdersFromEstimate(est, estId, sites, childProjectBySite, blockedTaskSites) {
    var salesOrderIds = [];
    var errors = [];
    var estimateLinesUpdated = 0;

    for (var i = 0; i < sites.length; i++) {
      var site = sites[i];
      var projectId = childProjectBySite[String(site.id)];

      if (!projectId) {
        errors.push(makeBlockedError({
          key: 'blocked:so:site:' + site.id,
          type: 'Blocked Sales Order',
          label: 'Sales Order for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          message: 'Blocked because the child Project was not created.',
          blockedBy: 'Child Project'
        }));
        continue;
      }

      if (blockedTaskSites && blockedTaskSites[String(site.id)]) {
        errors.push(makeBlockedError({
          key: 'blocked:so:site:' + site.id,
          type: 'Blocked Sales Order',
          label: 'Sales Order for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          message: 'Blocked until failed Project Tasks for this site are corrected and retried.',
          blockedBy: 'Project Task'
        }));
        continue;
      }

      try {
        var soResult = createRolloutSalesOrderForSite(est, estId, site, projectId);
        salesOrderIds.push(soResult.salesOrderId);
        estimateLinesUpdated += soResult.estimateLinesUpdated || 0;
      } catch (e) {
        errors.push(makeSalesOrderError('Sales Order for Site ' + (site.text || site.id), e.message || String(e), {
          key: 'so:site:' + site.id,
          siteId: site.id,
          siteText: site.text,
          salesOrderId: e.salesOrderId || ''
        }));
      }
    }

    return {
      salesOrderIds: salesOrderIds,
      errors: errors,
      estimateLinesUpdated: estimateLinesUpdated
    };
  }

  function createRolloutSalesOrderForSite(est, estId, site, projectId) {
    var existingSalesOrderId = findExistingSalesOrderForProject(estId, projectId, site.id);
    if (existingSalesOrderId) {
      return {
        salesOrderId: existingSalesOrderId,
        lineCount: 0,
        estimateLinesUpdated: updateEstimateLinesWithSalesOrder(estId, existingSalesOrderId, site.id),
        reused: true
      };
    }

    var lines = getSalesOrderLinesForSite(est, site.id);
    if (!lines.length) {
      throw new Error('No Estimate item lines found for Site Asset ' + (site.text || site.id) + '.');
    }

    var salesOrderId;

    try {
      var salesOrder = record.create({
        type: record.Type.SALES_ORDER,
        isDynamic: false
      });

      setIfPresent(salesOrder, 'entity', est.getValue(EST.ENTITY));
      setIfPresent(salesOrder, 'subsidiary', est.getValue(EST.SUBSIDIARY));
      setIfPresent(salesOrder, 'trandate', est.getValue(EST.TRANDATE));
      setIfPresent(salesOrder, 'salesrep', est.getValue(EST.SALESREP));
      setIfPresent(salesOrder, 'department', est.getValue(EST.DEPARTMENT));
      setIfPresent(salesOrder, 'class', est.getValue(EST.CLASS));
      setIfPresent(salesOrder, 'location', est.getValue(EST.LOCATION));
      setSalesOrderExternalId(salesOrder, estId, projectId);
      salesOrder.setValue({ fieldId: SO.PROJECT, value: projectId });
      salesOrder.setValue({ fieldId: SO.SOURCE_ESTIMATE, value: estId });

      for (var i = 0; i < lines.length; i++) {
        salesOrder.setSublistValue({
          sublistId: 'item',
          fieldId: 'item',
          line: i,
          value: lines[i].itemId
        });
        setSublistIfPresent(salesOrder, 'item', 'units', i, lines[i].units);
        setSublistIfPresent(salesOrder, 'item', 'quantity', i, lines[i].quantity);
        setSublistIfPresent(salesOrder, 'item', 'department', i, lines[i].department);
        setSublistIfPresent(salesOrder, 'item', 'class', i, lines[i].classId);
        setSublistIfPresent(salesOrder, 'item', 'location', i, lines[i].location);
        setSublistIfPresent(salesOrder, 'item', EST_LINE.TAX_CODE, i, lines[i].taxCode);
        ensureSalesOrderLineAmount(salesOrder, i, lines[i]);
        applyCpqJsonColumnsToSalesOrderLine(salesOrder, i, lines[i]);
        salesOrder.setSublistValue({
          sublistId: 'item',
          fieldId: SO.PROJECT,
          line: i,
          value: projectId
        });
      }

      salesOrderId = salesOrder.save({
        enableSourcing: true,
        ignoreMandatoryFields: true
      });

      return {
        salesOrderId: salesOrderId,
        lineCount: lines.length,
        estimateLinesUpdated: updateEstimateLinesWithSalesOrder(estId, salesOrderId, site.id)
      };
    } catch (e) {
      if (salesOrderId) {
        var wrapped = new Error('Sales Order ' + salesOrderId + ' was created, but Estimate linkage failed: ' + (e.message || String(e)));
        wrapped.salesOrderId = salesOrderId;
        throw wrapped;
      }
      var existingAfterError = findExistingSalesOrderForProject(estId, projectId, site.id);
      if (existingAfterError) {
        return {
          salesOrderId: existingAfterError,
          lineCount: 0,
          estimateLinesUpdated: updateEstimateLinesWithSalesOrder(estId, existingAfterError, site.id),
          reused: true,
          recoveredAfterSaveError: true
        };
      }
      throw e;
    }
  }

  function getSalesOrderLinesForSite(est, siteAssetId) {
    var lines = [];
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = 0; i < lineCount; i++) {
      var itemId = est.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
      var lineSiteAssetId = est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i });

      if (!itemId || String(lineSiteAssetId || '') !== String(siteAssetId)) continue;

      var quantity = toNumber(est.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }), 1);
      var itemType = est.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
      var sourceRate = est.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
      var sourceAmount = est.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i });
      var cpqKitJson = est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.CPQ_KIT_JSON, line: i });
      var baseLine = {
        itemId: itemId,
        quantity: quantity,
        rate: sourceRate,
        amount: sourceAmount,
        department: est.getSublistValue({ sublistId: 'item', fieldId: 'department', line: i }),
        classId: est.getSublistValue({ sublistId: 'item', fieldId: 'class', line: i }),
        location: est.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }),
        taxCode: est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.TAX_CODE, line: i })
      };

      if (isKitItemType(itemType)) {
        var componentLines = cpqKitJson ?
          buildCpqKitComponentLines(cpqKitJson, 'Estimate line ' + (i + 1)) :
          allocateKitComponentLines(getKitComponents(itemId), quantity, sourceAmount, sourceRate);

        for (var c = 0; c < componentLines.length; c++) {
          lines.push({
            itemId: componentLines[c].itemId,
            quantity: componentLines[c].quantity,
            rate: componentLines[c].rate,
            amount: componentLines[c].amount,
            units: componentLines[c].units,
            hours: componentLines[c].hours,
            numRuns: componentLines[c].numRuns,
            avgRunLength: componentLines[c].avgRunLength,
            unitCost: componentLines[c].unitCost,
            extendedCost: componentLines[c].extendedCost,
            grossMargin: componentLines[c].grossMargin,
            forceAmount: true,
            department: baseLine.department,
            classId: baseLine.classId,
            location: baseLine.location,
            taxCode: baseLine.taxCode
          });
        }
      } else {
        if (cpqKitJson) {
          mergeCpqSingleLineDetails(baseLine, cpqKitJson, 'Estimate line ' + (i + 1));
        }
        lines.push(baseLine);
      }
    }

    return lines;
  }

  function expandKitLinesOnSalesOrder(salesOrder, projectId, estimateLineCpqJsonByLine) {
    var expanded = 0;
    var lineCount = salesOrder.getLineCount({ sublistId: 'item' }) || 0;
    estimateLineCpqJsonByLine = estimateLineCpqJsonByLine || {};

    for (var i = lineCount - 1; i >= 0; i--) {
      var itemId = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
      var itemType = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });
      var cpqKitJson = getSublistValueSafe(salesOrder, 'item', EST_LINE.CPQ_KIT_JSON, i) ||
        estimateLineCpqJsonByLine[i] ||
        '';

      if (!itemId) continue;

      if (!isKitItemType(itemType)) {
        if (cpqKitJson) {
          var nonKitLineDetails = {
            itemId: itemId
          };
          mergeCpqSingleLineDetails(nonKitLineDetails, cpqKitJson, 'Sales Order transformed line ' + (i + 1));
          applyCpqJsonColumnsToSalesOrderLine(salesOrder, i, nonKitLineDetails);
        }
        continue;
      }

      var quantity = toNumber(salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }), 1);
      var sourceRate = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
      var sourceAmount = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i });
      var department = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'department', line: i });
      var classId = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'class', line: i });
      var location = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i });
      var taxCode = salesOrder.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.TAX_CODE, line: i });
      var componentLines = cpqKitJson ?
        buildCpqKitComponentLines(cpqKitJson, 'Sales Order transformed line ' + (i + 1)) :
        allocateKitComponentLines(getKitComponents(itemId), quantity, sourceAmount, sourceRate);

      if (!componentLines.length) continue;

      salesOrder.removeLine({
        sublistId: 'item',
        line: i,
        ignoreRecalc: true
      });

      for (var c = componentLines.length - 1; c >= 0; c--) {
        salesOrder.insertLine({
          sublistId: 'item',
          line: i,
          ignoreRecalc: true
        });
        salesOrder.setSublistValue({ sublistId: 'item', fieldId: 'item', line: i, value: componentLines[c].itemId });
        setSublistIfPresent(salesOrder, 'item', 'units', i, componentLines[c].units);
        setSublistIfPresent(salesOrder, 'item', 'quantity', i, componentLines[c].quantity);
        setSublistIfPresent(salesOrder, 'item', 'department', i, department);
        setSublistIfPresent(salesOrder, 'item', 'class', i, classId);
        setSublistIfPresent(salesOrder, 'item', 'location', i, location);
        setSublistIfPresent(salesOrder, 'item', EST_LINE.TAX_CODE, i, taxCode);
        ensureSalesOrderLineAmount(salesOrder, i, {
          quantity: componentLines[c].quantity,
          rate: componentLines[c].rate,
          amount: componentLines[c].amount,
          forceAmount: true
        });
        applyCpqJsonColumnsToSalesOrderLine(salesOrder, i, componentLines[c]);
        salesOrder.setSublistValue({ sublistId: 'item', fieldId: SO.PROJECT, line: i, value: projectId });
      }

      expanded++;
    }

    return expanded;
  }

  function getEstimateLineCpqJsonByLine(estId) {
    var map = {};

    try {
      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });
      var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

      for (var i = 0; i < lineCount; i++) {
        map[i] = est.getSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.CPQ_KIT_JSON,
          line: i
        }) || '';
      }
    } catch (e) {
      log.error({
        title: 'BC Estimate CPQ kit JSON lookup failed',
        details: JSON.stringify({
          estimateId: estId,
          error: getErrorDetails(e)
        })
      });
      throw e;
    }

    return map;
  }

  function isKitItemType(itemType) {
    return String(itemType || '').toLowerCase().indexOf('kit') !== -1;
  }

  function getKitComponents(kitItemId) {
    var kit = record.load({
      type: record.Type.KIT_ITEM || 'kititem',
      id: kitItemId,
      isDynamic: false
    });
    var components = [];
    var count = kit.getLineCount({ sublistId: 'member' }) || 0;

    for (var i = 0; i < count; i++) {
      var itemId = kit.getSublistValue({ sublistId: 'member', fieldId: 'item', line: i });
      if (!itemId) continue;
      components.push({
        itemId: itemId,
        quantity: toNumber(kit.getSublistValue({ sublistId: 'member', fieldId: 'quantity', line: i }), 1),
        rate: '',
        amount: ''
      });
    }

    return components;
  }

  function allocateKitComponentLines(components, kitQuantity, kitAmount, kitRate) {
    var lines = [];
    if (!components || !components.length) return lines;

    var totalAmount = isBlankValue(kitAmount)
      ? toNumber(kitRate, 0) * toNumber(kitQuantity, 1)
      : toNumber(kitAmount, 0);
    var totalQuantity = 0;

    for (var i = 0; i < components.length; i++) {
      totalQuantity += toNumber(kitQuantity, 1) * toNumber(components[i].quantity, 1);
    }

    if (!totalQuantity) totalQuantity = toNumber(kitQuantity, 1) || 1;

    var unitRate = totalAmount / totalQuantity;
    var allocatedTotal = 0;

    for (var c = 0; c < components.length; c++) {
      var componentQuantity = toNumber(kitQuantity, 1) * toNumber(components[c].quantity, 1);
      var amount = c === components.length - 1
        ? roundCurrency(totalAmount - allocatedTotal)
        : roundCurrency(unitRate * componentQuantity);

      allocatedTotal += amount;

      lines.push({
        itemId: components[c].itemId,
        quantity: componentQuantity,
        rate: componentQuantity ? amount / componentQuantity : 0,
        amount: amount
      });
    }

    return lines;
  }

  function buildCpqKitComponentLines(jsonText, contextLabel) {
    var entries = parseCpqKitJsonEntries(jsonText, contextLabel);
    if (!entries.length) throw new Error(contextLabel + ': CPQ kit JSON does not contain any component lines.');

    var lines = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var itemId = normalizeRecordId(entry.itemId);
      if (!itemId) throw new Error(contextLabel + ': CPQ kit JSON component is missing the item internal ID.');

      lines.push({
        itemId: itemId,
        quantity: requireCpqNumber(entry.data.qty, contextLabel + ' component ' + itemId + ' qty'),
        rate: requireCpqNumber(entry.data.matSellUnit, contextLabel + ' component ' + itemId + ' matSellUnit'),
        amount: requireCpqNumber(entry.data.extMatSell, contextLabel + ' component ' + itemId + ' extMatSell'),
        units: getCpqUnitValue(entry.data.uom, contextLabel + ' component ' + itemId),
        hours: entry.data.hrs,
        numRuns: entry.data.numRuns,
        avgRunLength: entry.data.avgRunLength,
        unitCost: entry.data.cost,
        extendedCost: entry.data.extMatCost,
        grossMargin: entry.data.grossMgn,
        forceAmount: true
      });
    }

    return lines;
  }

  function mergeCpqSingleLineDetails(line, jsonText, contextLabel) {
    var entries = parseCpqKitJsonEntries(jsonText, contextLabel);
    if (entries.length !== 1) {
      throw new Error(contextLabel + ': CPQ JSON for a non-kit item must contain exactly one line detail object.');
    }

    var data = entries[0].data;
    line.units = getCpqUnitValue(data.uom, contextLabel);
    line.hours = data.hrs;
    line.numRuns = data.numRuns;
    line.avgRunLength = data.avgRunLength;
    line.unitCost = data.cost;
    line.extendedCost = data.extMatCost;
    line.grossMargin = data.grossMgn;
    return line;
  }

  function parseCpqKitJsonEntries(jsonText, contextLabel) {
    var parsed;
    try {
      parsed = JSON.parse(String(jsonText || ''));
    } catch (e) {
      throw new Error(contextLabel + ': CPQ kit JSON is invalid. ' + (e.message || String(e)));
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(contextLabel + ': CPQ kit JSON must be an object keyed by item internal ID.');
    }

    var entries = [];
    for (var itemId in parsed) {
      if (!parsed.hasOwnProperty(itemId)) continue;
      if (!parsed[itemId] || typeof parsed[itemId] !== 'object' || Array.isArray(parsed[itemId])) {
        throw new Error(contextLabel + ': CPQ kit JSON component ' + itemId + ' must be an object.');
      }
      entries.push({
        itemId: itemId,
        data: parsed[itemId]
      });
    }

    return entries;
  }

  function applyCpqJsonColumnsToSalesOrderLine(salesOrder, line, sourceLine) {
    sourceLine = sourceLine || {};

    setSublistIfPresent(salesOrder, 'item', 'units', line, sourceLine.units);
    setSublistIfPresent(salesOrder, 'item', SO_LINE_JSON_FIELD.HOURS, line, sourceLine.hours);
    setSublistIfPresent(salesOrder, 'item', SO_LINE_JSON_FIELD.NUM_RUNS, line, normalizeBooleanLikeJsonValue(sourceLine.numRuns));
    setSublistIfPresent(salesOrder, 'item', SO_LINE_JSON_FIELD.AVG_RUN_LENGTH, line, normalizeBooleanLikeJsonValue(sourceLine.avgRunLength));
    setSublistIfPresent(salesOrder, 'item', SO_LINE_JSON_FIELD.UNIT_COST, line, sourceLine.unitCost);
    setSublistIfPresent(salesOrder, 'item', SO_LINE_JSON_FIELD.EXTENDED_COST, line, sourceLine.extendedCost);
    setSublistIfPresent(salesOrder, 'item', SO_LINE_JSON_FIELD.GROSS_MARGIN, line, sourceLine.grossMargin);
  }

  function requireCpqNumber(value, label) {
    if (isBlankValue(value) || value === false) throw new Error(label + ' is missing.');

    var num = toNumber(value, null);
    if (num === null || isNaN(num)) throw new Error(label + ' is not a valid number.');
    return num;
  }

  function getCpqUnitValue(value, contextLabel) {
    if (isBlankValue(value) || value === false) return '';
    if (/^\d+$/.test(String(value))) return String(value);

    var key = String(value).toLowerCase().trim();
    var unitId = CPQ_UOM_BY_NAME[key];
    if (!unitId) throw new Error(contextLabel + ': CPQ UOM "' + value + '" is not mapped to a NetSuite unit.');
    return unitId;
  }

  function normalizeBooleanLikeJsonValue(value) {
    return value === false ? '' : value;
  }

  function createProjectTasksForEstimate(est, estId, resolveProjectId) {
    var stagingRecords = getTaskStagingRecordsForEstimate(est, estId, { logWarnings: true });
    var taskIds = [];
    var errors = [];
    var warnings = [];
    var expectedTaskCount = 0;
    var taskDateStateByProject = {};

    log.audit({
      title: 'BC Project Task processing started',
      details: JSON.stringify({
        estimateId: estId,
        stagingRecordCount: stagingRecords.records.length,
        warningCount: stagingRecords.warnings.length
      })
    });

    for (var i = 0; i < stagingRecords.warnings.length; i++) {
      warnings.push(stagingRecords.warnings[i]);
    }

    for (var s = 0; s < stagingRecords.records.length; s++) {
      var staging = stagingRecords.records[s];
      var taskRows = [];

      try {
        taskRows = parseTaskJson(staging.json, staging.id);
        log.audit({
          title: 'BC Project Task staging parsed',
          details: JSON.stringify({
            estimateId: estId,
            stagingId: staging.id,
            lineRef: staging.lineRef || '',
            siteAssetId: staging.siteAssetId || '',
            taskRowCount: taskRows.length
          })
        });
      } catch (jsonError) {
        log.error({
          title: 'BC Project Task JSON parse failed',
          details: JSON.stringify({
            estimateId: estId,
            stagingId: staging.id,
            error: getErrorDetails(jsonError)
          })
        });
        errors.push(makeTaskError(staging, null, jsonError.message || String(jsonError)));
      }

      expectedTaskCount += taskRows.length;

      for (var t = 0; t < taskRows.length; t++) {
        var taskData = taskRows[t];
        taskData.__bcTaskIndex = t + 1;

        try {
          var projectId = resolveProjectId(staging, taskData);
          applyProjectTaskSchedule(est, projectId, taskData, taskDateStateByProject);

          var existingTaskId = findExistingProjectTask(estId, projectId, taskData.title, staging, taskData);
          if (existingTaskId) {
            taskIds.push(existingTaskId);
            log.audit({
              title: 'BC Project Task reused',
              details: JSON.stringify({
                estimateId: estId,
                stagingId: staging.id,
                taskIndex: t + 1,
                projectId: projectId,
                taskId: existingTaskId,
                title: taskData.title || '',
                scheduledStartDate: taskData.__bcScheduledStartDate || '',
                originalStartDate: taskData.__bcOriginalStartDate || ''
              })
            });
            continue;
          }

          log.audit({
            title: 'BC Project Task create attempt',
            details: JSON.stringify({
              estimateId: estId,
              stagingId: staging.id,
              taskIndex: t + 1,
              projectId: projectId,
              title: taskData.title || '',
              status: taskData.status || '',
              estimatedwork: taskData.estimatedwork || '',
              plannedwork: taskData.plannedwork || '',
              duration: taskData.duration || '',
              startdate: taskData.startdate || '',
              originalStartDate: taskData.__bcOriginalStartDate || '',
              starttime: taskData.starttime || '',
              taskType: taskData.custevent_nx_task_type || '',
              taskAsset: taskData[TASK.ASSET] || staging.siteAssetId || est.getValue(EST.SITE_ASSET) || ''
            })
          });
          taskIds.push(createProjectTask({
            estimate: est,
            estimateId: estId,
            projectId: projectId,
            staging: staging,
            taskData: taskData
          }));
        } catch (taskError) {
          log.error({
            title: 'BC Project Task create failed',
            details: JSON.stringify({
              estimateId: estId,
              stagingId: staging.id,
              taskIndex: t + 1,
              title: taskData && taskData.title ? taskData.title : '',
              error: getErrorDetails(taskError),
              taskData: taskData
            })
          });
          errors.push(makeTaskError(staging, taskData, taskError.message || String(taskError)));
        }
      }

      log.audit({
        title: 'BC Project Task staging completed',
        details: JSON.stringify({
          estimateId: estId,
          stagingId: staging.id,
          createdTaskCountSoFar: taskIds.length,
          errorCountSoFar: errors.length
        })
      });
    }

    return {
      taskIds: taskIds,
      expectedTaskCount: expectedTaskCount,
      errors: errors,
      warnings: warnings
    };
  }

  function createProjectTask(opts) {
    var taskData = opts.taskData || {};
    var task = record.create({
      type: record.Type.PROJECT_TASK,
      isDynamic: true
    });

    task.setValue({ fieldId: TASK.PROJECT, value: opts.projectId });
    task.setValue({ fieldId: TASK.SOURCE_ESTIMATE, value: opts.estimateId });
    setProjectTaskExternalId(task, opts);

    setTaskField(task, TASK.TITLE, taskData.title);
    setTaskField(task, 'status', taskData.status);
    setTaskField(task, 'estimatedwork', taskData.estimatedwork);
    setTaskField(task, 'constrainttype', taskData.constrainttype);
    setTaskField(task, 'duration', taskData.duration);
    setTaskField(task, 'plannedwork', taskData.plannedwork);
    setTaskField(task, 'startdate', getProjectTaskStartDate(opts, taskData));
    setTaskField(task, 'starttime', taskData.starttime);
    setTaskField(task, 'custevent_nx_task_type', taskData.custevent_nx_task_type);

    setTaskField(
      task,
      TASK.ASSET,
      taskData[TASK.ASSET] || opts.staging.siteAssetId || opts.estimate.getValue(EST.SITE_ASSET)
    );

    try {
      log.audit({
        title: 'BC Project Task save attempt',
        details: JSON.stringify({
          estimateId: opts.estimateId,
          projectId: opts.projectId,
          stagingId: opts.staging.id,
          title: taskData.title || '',
          bodyEstimatedWork: taskData.estimatedwork || '',
          bodyPlannedWork: taskData.plannedwork || ''
        })
      });

      var taskId = task.save({ enableSourcing: true, ignoreMandatoryFields: true });

      log.audit({
        title: 'BC Project Task saved',
        details: JSON.stringify({
          estimateId: opts.estimateId,
          projectId: opts.projectId,
          stagingId: opts.staging.id,
          taskId: taskId,
          title: taskData.title || ''
        })
      });

      return taskId;
    } catch (saveError) {
      log.error({
        title: 'BC Project Task save failed',
        details: JSON.stringify({
          estimateId: opts.estimateId,
          projectId: opts.projectId,
          stagingId: opts.staging.id,
          title: taskData.title || '',
          bodyFields: {
            status: taskData.status || '',
            estimatedwork: taskData.estimatedwork || '',
            plannedwork: taskData.plannedwork || '',
            duration: taskData.duration || '',
            constrainttype: taskData.constrainttype || '',
            startdate: taskData.startdate || '',
            starttime: taskData.starttime || '',
            taskType: taskData.custevent_nx_task_type || '',
            taskAsset: taskData[TASK.ASSET] || opts.staging.siteAssetId || opts.estimate.getValue(EST.SITE_ASSET) || ''
          },
          error: getErrorDetails(saveError)
        })
      });
      throw saveError;
    }
  }

  function getProjectTaskStartDate(opts, taskData) {
    if (taskData.__bcScheduledStartDate) return taskData.__bcScheduledStartDate;
    if (!isBlankValue(taskData.startdate)) return taskData.startdate;
    return opts.estimate.getValue(EST.PROJECT_START);
  }

  function applyProjectTaskSchedule(est, projectId, taskData, taskDateStateByProject) {
    var projectKey = String(projectId || 'default');
    var nextAvailableDate = taskDateStateByProject[projectKey] || getFirstProjectTaskBusinessDate(est);
    var originalStartDate = taskData.startdate;
    var providedStartDate = getDateOnlyValue(originalStartDate);
    var candidateDate = isBlankValue(originalStartDate) || !providedStartDate
      ? nextAvailableDate
      : getNextBusinessDate(providedStartDate);

    if (compareDateOnly(candidateDate, nextAvailableDate) < 0) {
      candidateDate = nextAvailableDate;
    }

    taskData.__bcOriginalStartDate = isBlankValue(originalStartDate) ? '' : originalStartDate;
    taskData.__bcScheduledStartDate = candidateDate;
    taskData.startdate = candidateDate;
    taskDateStateByProject[projectKey] = getNextBusinessDate(addDays(candidateDate, 1));

    return candidateDate;
  }

  function getFirstProjectTaskBusinessDate(est) {
    return getNextBusinessDate(est.getValue(EST.PROJECT_START) || new Date());
  }

  function getNextBusinessDate(value) {
    var date = getDateOnlyValue(value) || getDateOnlyValue(new Date());

    while (isWeekendDate(date)) {
      date = addDays(date, 1);
    }

    return date;
  }

  function getDateOnlyValue(value) {
    if (isBlankValue(value)) return null;

    var date = parseDateValue(value);
    if (!isValidDate(date)) return null;

    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function compareDateOnly(a, b) {
    var dateA = getDateOnlyValue(a);
    var dateB = getDateOnlyValue(b);
    if (!dateA && !dateB) return 0;
    if (!dateA) return -1;
    if (!dateB) return 1;
    return dateA.getTime() - dateB.getTime();
  }

  function isWeekendDate(date) {
    var day = date.getDay();
    return day === 0 || day === 6;
  }

  function isValidDate(date) {
    return Object.prototype.toString.call(date) === '[object Date]' && !isNaN(date.getTime());
  }

  function setTaskField(task, fieldId, value) {
    if (value === '' || value === null || value === undefined) return;

    task.setValue({
      fieldId: fieldId,
      value: normalizeTaskFieldValue(fieldId, value)
    });
  }

  function normalizeTaskFieldValue(fieldId, value) {
    if (fieldId === 'startdate') return parseDateValue(value);
    if (fieldId === 'starttime') return parseTimeValue(value);
    return value;
  }

  function parseDateValue(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') return value;

    try {
      return format.parse({
        value: String(value),
        type: format.Type.DATE
      });
    } catch (e) {
      return new Date(value);
    }
  }

  function parseTimeValue(value) {
    try {
      return format.parse({
        value: String(value),
        type: format.Type.TIMEOFDAY
      });
    } catch (e) {
      return value;
    }
  }

  function parseTaskJson(jsonText, stagingId) {
    if (!jsonText) throw new Error('Task JSON is blank on staging record ' + stagingId + '.');

    var parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) parsed = [parsed];

    return parsed;
  }

  function makeTaskError(staging, taskData, message) {
    return {
      key: 'task:staging:' + staging.id + ':index:' + (taskData && taskData.__bcTaskIndex ? taskData.__bcTaskIndex : 'json'),
      type: 'Project Task',
      label: 'Staging Record ' + staging.id + (taskData && taskData.title ? ' - ' + taskData.title : ''),
      siteId: staging.siteAssetId || '',
      siteText: staging.siteText || '',
      lineRef: staging.lineRef || '',
      stagingId: staging.id || '',
      taskIndex: taskData && taskData.__bcTaskIndex ? taskData.__bcTaskIndex : '',
      message: message
    };
  }

  function makeSalesOrderError(label, message, opts) {
    opts = opts || {};
    return {
      key: opts.key || makeFallbackErrorKey({ type: 'Sales Order', siteId: opts.siteId }, 0),
      type: 'Sales Order',
      label: label,
      siteId: opts.siteId || '',
      siteText: opts.siteText || '',
      salesOrderId: opts.salesOrderId || '',
      message: message
    };
  }

  function makeBlockedError(opts) {
    opts = opts || {};
    return {
      key: opts.key || makeFallbackErrorKey({ type: opts.type || 'Blocked', siteId: opts.siteId }, 0),
      type: opts.type || 'Blocked',
      label: opts.label || '',
      siteId: opts.siteId || '',
      siteText: opts.siteText || '',
      lineRef: opts.lineRef || '',
      blockedBy: opts.blockedBy || '',
      retryable: opts.retryable !== false,
      message: opts.message || ''
    };
  }

  function rollbackSiteProjectsForErrors(estId, childProjectBySite, errors, opts) {
    var result = {
      deletedProjectIds: [],
      deletedSalesOrderIds: [],
      errors: [],
      warnings: []
    };
    var siteMap = getErrorSiteMap(errors);

    for (var siteId in siteMap) {
      if (!siteMap.hasOwnProperty(siteId)) continue;

      var projectId = childProjectBySite[String(siteId)];
      if (!projectId) continue;

      var rollback = rollbackGeneratedProject(estId, projectId, {
        siteAssetId: siteId,
        reason: opts && opts.reason ? opts.reason : 'Rollout site generation failed.'
      });

      result.errors = result.errors.concat(rollback.errors);
      result.warnings = result.warnings.concat(rollback.warnings);
      result.deletedSalesOrderIds = result.deletedSalesOrderIds.concat(rollback.deletedSalesOrderIds);

      if (rollback.success) {
        result.deletedProjectIds.push(projectId);
        delete childProjectBySite[String(siteId)];
      }
    }

    return result;
  }

  function rollbackGeneratedProject(estId, projectId, opts) {
    opts = opts || {};
    var result = {
      success: true,
      deletedProjectId: '',
      deletedTaskIds: [],
      deletedSalesOrderIds: [],
      errors: [],
      warnings: []
    };

    if (!projectId) return result;

    log.audit({
      title: 'BC Generation rollback started',
      details: JSON.stringify({
        estimateId: estId,
        projectId: projectId,
        siteAssetId: opts.siteAssetId || '',
        reason: opts.reason || ''
      })
    });

    var salesOrderIds = findGeneratedSalesOrderIdsForProject(estId, projectId, opts.siteAssetId);
    if (opts.salesOrderId) addUniqueId(salesOrderIds, opts.salesOrderId);

    for (var so = 0; so < salesOrderIds.length; so++) {
      if (deleteGeneratedRecord(record.Type.SALES_ORDER, salesOrderIds[so], 'Sales Order', result)) {
        result.deletedSalesOrderIds.push(String(salesOrderIds[so]));
      }
    }

    clearEstimateSalesOrderLinks(estId, opts.siteAssetId, result.deletedSalesOrderIds, result);

    var taskIds = findGeneratedProjectTaskIdsForProject(estId, projectId);
    for (var t = 0; t < taskIds.length; t++) {
      if (deleteGeneratedRecord(record.Type.PROJECT_TASK, taskIds[t], 'Project Task', result)) {
        result.deletedTaskIds.push(String(taskIds[t]));
      }
    }

    if (deleteGeneratedRecord(record.Type.JOB, projectId, 'Project', result)) {
      result.deletedProjectId = String(projectId);
      clearEstimateProjectReferenceIfMatches(estId, projectId, result);
    }

    log.audit({
      title: 'BC Generation rollback completed',
      details: JSON.stringify({
        estimateId: estId,
        projectId: projectId,
        success: result.success,
        deletedSalesOrderIds: result.deletedSalesOrderIds,
        deletedTaskIds: result.deletedTaskIds,
        deletedProjectId: result.deletedProjectId,
        errorCount: result.errors.length
      })
    });

    return result;
  }

  function deleteGeneratedRecord(recordType, recordId, label, result) {
    if (!recordId) return false;

    try {
      record.delete({
        type: recordType,
        id: recordId
      });
      return true;
    } catch (e) {
      result.success = false;
      result.errors.push({
        key: 'rollback:' + String(label || 'record').toLowerCase().replace(/\s+/g, '-') + ':' + recordId,
        type: 'Rollback',
        label: 'Delete ' + label + ' ' + recordId,
        retryable: false,
        message: e.message || String(e)
      });
      log.error({
        title: 'BC Generation rollback delete failed',
        details: JSON.stringify({
          recordType: recordType,
          recordId: recordId,
          label: label,
          error: getErrorDetails(e)
        })
      });
      return false;
    }
  }

  function clearEstimateProjectReferenceIfMatches(estId, projectId, result) {
    try {
      var currentProjectId = search.lookupFields({
        type: search.Type.ESTIMATE || 'estimate',
        id: estId,
        columns: [EST.GENERATED_PROJECT]
      })[EST.GENERATED_PROJECT];

      currentProjectId = normalizeRecordId(currentProjectId);
      if (String(currentProjectId || '') !== String(projectId || '')) return;

      var values = {};
      values[EST.GENERATED_PROJECT] = '';
      record.submitFields({
        type: record.Type.ESTIMATE,
        id: estId,
        values: values,
        options: {
          enableSourcing: false,
          ignoreMandatoryFields: true
        }
      });
    } catch (e) {
      result.success = false;
      result.errors.push({
        key: 'rollback:estimate-project-link:' + estId + ':' + projectId,
        type: 'Rollback',
        label: 'Clear Estimate Project reference',
        retryable: false,
        message: e.message || String(e)
      });
    }
  }

  function findGeneratedProjectTaskIdsForProject(estId, projectId) {
    var ids = [];

    search.create({
      type: search.Type.PROJECT_TASK || 'projecttask',
      filters: [
        [TASK.SOURCE_ESTIMATE, 'anyof', estId],
        'AND',
        [TASK.PROJECT, 'anyof', projectId]
      ],
      columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
    }).run().each(function (result) {
      addUniqueId(ids, result.getValue({ name: 'internalid' }));
      return true;
    });

    return ids;
  }

  function findGeneratedSalesOrderIdsForProject(estId, projectId, siteAssetId) {
    var ids = [];
    var existingSalesOrderId = findExistingSalesOrderForProject(estId, projectId, siteAssetId);
    if (existingSalesOrderId) addUniqueId(ids, existingSalesOrderId);

    var linkedIds = findLinkedSalesOrderIdsFromEstimateLines(estId, siteAssetId);
    for (var i = 0; i < linkedIds.length; i++) {
      if (salesOrderBelongsToEstimateProject(linkedIds[i], estId, projectId)) {
        addUniqueId(ids, linkedIds[i]);
      }
    }

    return ids;
  }

  function salesOrderBelongsToEstimateProject(salesOrderId, estId, projectId) {
    try {
      var salesOrder = record.load({
        type: record.Type.SALES_ORDER,
        id: salesOrderId,
        isDynamic: false
      });
      var sourceEstimateId = String(salesOrder.getValue({ fieldId: SO.SOURCE_ESTIMATE }) || '');
      var salesOrderProjectId = String(salesOrder.getValue({ fieldId: SO.PROJECT }) || '');

      return sourceEstimateId === String(estId || '') || salesOrderProjectId === String(projectId || '');
    } catch (e) {
      log.audit({
        title: 'BC Rollback Sales Order ownership check skipped',
        details: JSON.stringify({
          salesOrderId: salesOrderId,
          estimateId: estId,
          projectId: projectId,
          error: getErrorDetails(e)
        })
      });
      return false;
    }
  }

  function findLinkedSalesOrderIdsFromEstimateLines(estId, siteAssetId) {
    var ids = [];

    try {
      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });
      var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

      for (var i = 0; i < lineCount; i++) {
        if (!shouldAttachSalesOrderToEstimateLine(est, i, siteAssetId)) continue;
        addUniqueId(ids, normalizeRecordId(est.getSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.RELATED_SALES_ORDER,
          line: i
        })));
      }
    } catch (e) {
      log.audit({
        title: 'BC Rollback Estimate line Sales Order lookup skipped',
        details: JSON.stringify({
          estimateId: estId,
          siteAssetId: siteAssetId || '',
          error: getErrorDetails(e)
        })
      });
    }

    return ids;
  }

  function clearEstimateSalesOrderLinks(estId, siteAssetId, salesOrderIds, result) {
    if (!salesOrderIds || !salesOrderIds.length) return;

    try {
      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });
      var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;
      var changed = false;

      for (var i = 0; i < lineCount; i++) {
        if (!shouldAttachSalesOrderToEstimateLine(est, i, siteAssetId)) continue;

        var linkedSalesOrderId = normalizeRecordId(est.getSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.RELATED_SALES_ORDER,
          line: i
        }));

        if (!containsId(salesOrderIds, linkedSalesOrderId)) continue;

        est.setSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.RELATED_SALES_ORDER,
          line: i,
          value: ''
        });
        changed = true;
      }

      if (changed) {
        est.save({
          enableSourcing: true,
          ignoreMandatoryFields: true
        });
      }
    } catch (e) {
      result.success = false;
      result.errors.push({
        key: 'rollback:estimate-so-links:' + estId + ':' + (siteAssetId || 'all'),
        type: 'Rollback',
        label: 'Clear Estimate Sales Order links',
        retryable: false,
        message: e.message || String(e)
      });
    }
  }

  function filterSitesWithProjects(sites, childProjectBySite) {
    var filtered = [];
    for (var i = 0; i < (sites || []).length; i++) {
      if (childProjectBySite[String(sites[i].id)]) filtered.push(sites[i]);
    }
    return filtered;
  }

  function removeIds(ids, idsToRemove) {
    var removeMap = {};
    for (var i = 0; i < (idsToRemove || []).length; i++) {
      removeMap[String(idsToRemove[i])] = true;
    }

    var filtered = [];
    for (var j = 0; j < (ids || []).length; j++) {
      if (!removeMap[String(ids[j])]) filtered.push(ids[j]);
    }
    return filtered;
  }

  function addUniqueId(ids, id) {
    id = normalizeRecordId(id);
    if (!id || containsId(ids, id)) return;
    ids.push(String(id));
  }

  function containsId(ids, id) {
    id = String(normalizeRecordId(id) || '');
    if (!id) return false;
    for (var i = 0; i < (ids || []).length; i++) {
      if (String(normalizeRecordId(ids[i]) || '') === id) return true;
    }
    return false;
  }

  function getErrorSiteMap(errors) {
    var map = {};
    for (var i = 0; i < (errors || []).length; i++) {
      if (errors[i].siteId) map[String(errors[i].siteId)] = true;
    }
    return map;
  }

  function getTaskStagingRecordsForEstimate(est, estId, opts) {
    var recordsById = {};
    var warnings = [];
    var lines = getEstimateLineTaskContexts(est);
    var ids = [];

    for (var i = 0; i < lines.length; i++) {
      for (var idIndex = 0; idIndex < lines[i].stagingIds.length; idIndex++) {
        var stagingId = lines[i].stagingIds[idIndex];
        ids.push(stagingId);
      }
    }

    if (ids.length) {
      addStagingRecordsByIds(recordsById, ids, lines);
    }

    for (var l = 0; l < lines.length; l++) {
      if (lines[l].stagingIds.length) continue;

      var beforeCount = Object.keys(recordsById).length;
      addStagingRecordsByEstimateLine(recordsById, estId, lines[l]);
      var afterCount = Object.keys(recordsById).length;

      if (beforeCount === afterCount) {
        var warning = 'No Project Task staging record found for Estimate line ' + lines[l].lineRef + ' (' + lines[l].itemText + ').';
        warnings.push(warning);
        if (opts && opts.logWarnings) {
          log.audit({
            title: 'BC Project Task staging missing',
            details: warning
          });
        }
      }
    }

    return {
      records: sortStagingRecords(objectValues(recordsById)),
      warnings: warnings
    };
  }

  function getEstimateLineTaskContexts(est) {
    var lines = [];
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = 0; i < lineCount; i++) {
      var lineRef = est.getSublistValue({
        sublistId: 'item',
        fieldId: 'line',
        line: i
      }) || (i + 1);

      lines.push({
        index: i,
        lineRef: String(lineRef),
        itemId: est.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }),
        itemText: est.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || '',
        siteAssetId: est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i }),
        siteText: est.getSublistText({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i }) || '',
        stagingIds: parseStagingIds(est.getSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.STAGING_IDS,
          line: i
        }))
      });
    }

    return lines;
  }

  function addStagingRecordsByIds(recordsById, ids, lines) {
    var lineByStagingId = {};

    for (var i = 0; i < lines.length; i++) {
      for (var idIndex = 0; idIndex < lines[i].stagingIds.length; idIndex++) {
        lineByStagingId[String(lines[i].stagingIds[idIndex])] = lines[i];
      }
    }

    search.create({
      type: STAGING.TYPE,
      filters: [['internalid', 'anyof', ids]],
      columns: getStagingSearchColumns()
    }).run().each(function (result) {
      var id = result.getValue({ name: 'internalid' });
      var lineContext = lineByStagingId[String(id)] || {};
      recordsById[String(id)] = makeStagingRecordFromSearch(result, lineContext);
      return true;
    });
  }

  function addStagingRecordsByEstimateLine(recordsById, estId, lineContext) {
    search.create({
      type: STAGING.TYPE,
      filters: [
        [STAGING.TRANSACTION, 'anyof', estId],
        'AND',
        [STAGING.LINE_REF, 'is', lineContext.lineRef]
      ],
      columns: getStagingSearchColumns()
    }).run().each(function (result) {
      var id = result.getValue({ name: 'internalid' });
      recordsById[String(id)] = makeStagingRecordFromSearch(result, lineContext);
      return true;
    });
  }

  function getStagingSearchColumns() {
    return [
      search.createColumn({ name: 'internalid' }),
      search.createColumn({ name: STAGING.NAME }),
      search.createColumn({ name: STAGING.JSON }),
      search.createColumn({ name: STAGING.LINE_REF })
    ];
  }

  function makeStagingRecordFromSearch(result, lineContext) {
    return {
      id: result.getValue({ name: 'internalid' }),
      name: result.getValue({ name: STAGING.NAME }),
      json: result.getValue({ name: STAGING.JSON }),
      lineRef: result.getValue({ name: STAGING.LINE_REF }) || lineContext.lineRef,
      lineIndex: lineContext.index,
      itemId: lineContext.itemId,
      itemText: lineContext.itemText,
      siteAssetId: lineContext.siteAssetId,
      siteText: lineContext.siteText
    };
  }

  function sortStagingRecords(records) {
    return (records || []).sort(function (a, b) {
      var lineA = a.lineIndex !== undefined && a.lineIndex !== null ? toNumber(a.lineIndex, 999999) : toNumber(a.lineRef, 999999);
      var lineB = b.lineIndex !== undefined && b.lineIndex !== null ? toNumber(b.lineIndex, 999999) : toNumber(b.lineRef, 999999);
      if (lineA !== lineB) return lineA - lineB;

      var lineRefA = toNumber(a.lineRef, 999999);
      var lineRefB = toNumber(b.lineRef, 999999);
      if (lineRefA !== lineRefB) return lineRefA - lineRefB;

      return toNumber(a.id, 999999) - toNumber(b.id, 999999);
    });
  }

  function parseStagingIds(value) {
    if (value === '' || value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.map(String);

    var matches = String(value).match(/\d+/g);
    return matches || [];
  }

  function buildPartialFailureResult(opts) {
    var projectErrors = opts.projectErrors || opts.errors || [];
    var taskErrors = opts.taskErrors || [];
    var salesOrderErrors = opts.salesOrderErrors || [];
    var warnings = opts.warnings || [];
    var allErrors = projectErrors.concat(taskErrors).concat(salesOrderErrors);
    var createdCount = opts.projectIds ? opts.projectIds.length : 0;
    var expectedCount = opts.expectedProjectCount || createdCount;
    var anyCreated = createdCount > 0 ||
      (opts.taskIds && opts.taskIds.length > 0) ||
      (opts.salesOrderIds && opts.salesOrderIds.length > 0);

    if (opts.estimateId) {
      persistGenerationErrors(
        opts.estimateId,
        allErrors,
        warnings,
        anyCreated ? GEN_STATUS.PARTIAL_ERROR : GEN_STATUS.FAILED
      );
    }

    return {
      success: false,
      partial: anyCreated,
      flowType: opts.flowType,
      parentProjectId: opts.parentProjectId,
      childProjectIds: opts.childProjectIds || [],
      projectIds: opts.projectIds || [],
      projectCount: createdCount,
      expectedProjectCount: expectedCount,
      salesOrderIds: opts.salesOrderIds || [],
      salesOrderCount: opts.salesOrderIds ? opts.salesOrderIds.length : 0,
      taskIds: opts.taskIds || [],
      taskCount: opts.taskIds ? opts.taskIds.length : 0,
      expectedTaskCount: opts.expectedTaskCount || 0,
      failedProjectCount: projectErrors.length,
      failedTaskCount: taskErrors.length,
      failedSalesOrderCount: salesOrderErrors.length,
      siteCount: opts.siteCount,
      errors: allErrors,
      projectErrors: projectErrors,
      taskErrors: taskErrors,
      salesOrderErrors: salesOrderErrors,
      warnings: warnings,
      note: opts.note,
      error: 'Generation completed with errors. Created ' + createdCount + ' of ' + expectedCount + ' expected Projects.'
    };
  }

  function buildGenerationResultPage(result) {
    var async = result.async === true;
    var success = result.success === true && !async;
    var partial = result.partial === true;
    var statusText = async ? (result.queued ? 'Queued' : 'Processing') : success ? 'Complete' : partial ? 'Completed with Errors' : 'Failed';
    var barColor = async ? '#2563eb' : success ? '#059669' : partial ? '#d97706' : '#dc2626';
    var expected = result.expectedProjectCount || result.projectCount || 0;
    var created = result.projectCount || 0;
    var percent = expected ? Math.min(100, Math.round((created / expected) * 100)) : (success ? 100 : 0);
    var errorRows = result.errors && result.errors.length ? result.errors.map(function (err) {
      return '<tr>' +
        '<td>' + escapeHtml(err.label || '') + '</td>' +
        '<td>' + escapeHtml(err.siteText || err.siteId || (err.lineRef ? 'Line ' + err.lineRef : '')) + '</td>' +
        '<td>' + escapeHtml(err.message || '') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="3">No project-level errors were returned.</td></tr>';

    return '<!doctype html><html><head><title>Project Generation Status</title>' +
      '<style>' +
      'body{font-family:Arial,sans-serif;margin:24px;color:#1f2937;background:#f8fafc;}' +
      '.wrap{max-width:980px;margin:0 auto;background:#fff;border:1px solid #d9e2ec;padding:20px;}' +
      '.bar{height:18px;background:#e5e7eb;border-radius:9px;overflow:hidden;margin:14px 0;}' +
      '.fill{height:18px;background:' + barColor + ';width:' + percent + '%;}' +
      '.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0;}' +
      '.box{border:1px solid #e5e7eb;background:#f9fafb;padding:12px;}' +
      '.label{font-size:12px;color:#6b7280;text-transform:uppercase;}' +
      '.value{font-size:20px;font-weight:700;margin-top:4px;}' +
      'table{width:100%;border-collapse:collapse;margin-top:16px;}' +
      'th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top;}' +
      'th{background:#f3f4f6;}' +
      '.actions{display:flex;justify-content:flex-end;gap:8px;margin:12px 0;}' +
      '.btn{border:1px solid #2563eb;background:#2563eb;color:#fff;padding:6px 10px;border-radius:4px;cursor:pointer;font-size:12px;}' +
      '</style>' +
      '<script>function bcOpenProgress(){var u=new URL(window.location.href);u.searchParams.set("action","progress");u.searchParams.delete("format");u.searchParams.delete("key");window.location.href=u.toString();}</script>' +
      '</head><body><div class="wrap">' +
      '<h2>Project Generation Status</h2>' +
      '<div>Status: <strong>' + escapeHtml(statusText) + '</strong></div>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<div>' + escapeHtml(result.note || result.error || '') + '</div>' +
      '<div class="actions"><button type="button" class="btn" onclick="bcOpenProgress()">Open Progress</button></div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Flow</div><div class="value">' + escapeHtml(result.flowType || '') + '</div></div>' +
        '<div class="box"><div class="label">Expected</div><div class="value">' + expected + '</div></div>' +
        '<div class="box"><div class="label">Created</div><div class="value">' + created + '</div></div>' +
        '<div class="box"><div class="label">Failed</div><div class="value">' + (result.failedProjectCount || 0) + '</div></div>' +
      '</div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Expected Tasks</div><div class="value">' + (result.expectedTaskCount || 0) + '</div></div>' +
        '<div class="box"><div class="label">Created Tasks</div><div class="value">' + (result.taskCount || 0) + '</div></div>' +
        '<div class="box"><div class="label">Failed Tasks</div><div class="value">' + (result.failedTaskCount || 0) + '</div></div>' +
        '<div class="box"><div class="label">Warnings</div><div class="value">' + ((result.warnings || []).length) + '</div></div>' +
      '</div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Sales Orders</div><div class="value">' + (result.salesOrderCount || 0) + '</div></div>' +
        '<div class="box"><div class="label">Failed SO</div><div class="value">' + (result.failedSalesOrderCount || 0) + '</div></div>' +
        '<div class="box"><div class="label">SO ID</div><div class="value">' + escapeHtml(result.salesOrderId || (result.salesOrderIds && result.salesOrderIds[0]) || '') + '</div></div>' +
        '<div class="box"><div class="label">Estimate Lines</div><div class="value">' + (result.estimateLinesUpdated || 0) + '</div></div>' +
      '</div>' +
      '<h3>Generation Errors</h3>' +
      '<table><thead><tr><th>Attempt</th><th>Site / Line</th><th>Error</th></tr></thead><tbody>' + errorRows + '</tbody></table>' +
      '</div></body></html>';
  }

  function markEstimateGenerated(estId, projectId) {
    clearGenerationErrors(estId, projectId);
  }

  function getUniqueLineSites(est) {
    var seen = {};
    var sites = [];
    var lineCount = est.getLineCount({ sublistId: 'item' });

    for (var i = 0; i < lineCount; i++) {
      var siteId = est.getSublistValue({
        sublistId: 'item',
        fieldId: EST_LINE.SITE_ASSET,
        line: i
      });

      if (!siteId || seen[String(siteId)]) continue;

      seen[String(siteId)] = true;
      sites.push({
        id: siteId,
        text: est.getSublistText({
          sublistId: 'item',
          fieldId: EST_LINE.SITE_ASSET,
          line: i
        })
      });
    }

    return sites;
  }

  function hasExistingGeneratedProjects(estId) {
    return search.create({
      type: search.Type.JOB,
      filters: [[PROJ.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: ['internalid']
    }).runPaged({ pageSize: 1 }).count > 0;
  }

  function findExistingStandardProject(estId) {
    var found = '';

    search.create({
      type: search.Type.JOB,
      filters: [[PROJ.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: PROJ.SITE_ASSET })
      ]
    }).run().each(function (result) {
      if (!result.getValue({ name: PROJ.SITE_ASSET })) {
        found = result.getValue({ name: 'internalid' });
        return false;
      }

      if (!found) found = result.getValue({ name: 'internalid' });
      return true;
    });

    return found;
  }

  function findExistingRolloutParentProject(est, estId) {
    var projectFromEstimate = est.getValue(EST.GENERATED_PROJECT);
    if (projectFromEstimate) return projectFromEstimate;

    var found = '';
    search.create({
      type: search.Type.JOB,
      filters: [[PROJ.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: PROJ.SITE_ASSET })
      ]
    }).run().each(function (result) {
      if (!result.getValue({ name: PROJ.SITE_ASSET })) {
        found = result.getValue({ name: 'internalid' });
        return false;
      }
      return true;
    });

    return found;
  }

  function getExistingChildProjectsBySite(estId) {
    var bySite = {};

    search.create({
      type: search.Type.JOB,
      filters: [[PROJ.SOURCE_ESTIMATE, 'anyof', estId]],
      columns: [
        search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
        search.createColumn({ name: PROJ.SITE_ASSET })
      ]
    }).run().each(function (result) {
      var siteId = result.getValue({ name: PROJ.SITE_ASSET });
      if (siteId && !bySite[String(siteId)]) {
        bySite[String(siteId)] = result.getValue({ name: 'internalid' });
      }
      return true;
    });

    return bySite;
  }

  function findExistingSalesOrderForProject(estId, projectId, siteAssetId) {
    var found = '';
    var externalId = makeSalesOrderExternalId(estId, projectId);
    var foundByExternalId = findExistingSalesOrderByExternalId(externalId);
    if (foundByExternalId && ensureSalesOrderHeaderLink(foundByExternalId, estId, projectId)) {
      return foundByExternalId;
    }

    search.create({
      type: search.Type.SALES_ORDER,
      filters: [
        [SO.SOURCE_ESTIMATE, 'anyof', estId],
        'AND',
        ['mainline', 'is', 'T']
      ],
      columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
    }).run().each(function (result) {
      var salesOrderId = result.getValue({ name: 'internalid' });

      if (salesOrderHasProject(salesOrderId, projectId)) {
        ensureSalesOrderHeaderLink(salesOrderId, estId, projectId);
        found = salesOrderId;
        return false;
      }

      return true;
    });

    if (found) return found;

    return findLinkedSalesOrderFromEstimateLines(estId, projectId, siteAssetId);
  }

  function findExistingSalesOrderByExternalId(externalId) {
    if (!externalId) return '';

    var found = '';
    try {
      search.create({
        type: search.Type.SALES_ORDER,
        filters: [
          ['externalid', 'is', externalId],
          'AND',
          ['mainline', 'is', 'T']
        ],
        columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
      }).run().each(function (result) {
        found = result.getValue({ name: 'internalid' });
        return false;
      });
    } catch (e) {
      log.audit({
        title: 'BC Sales Order external ID lookup skipped',
        details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) })
      });
    }

    return found;
  }

  function findLinkedSalesOrderFromEstimateLines(estId, projectId, siteAssetId) {
    try {
      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });
      var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

      for (var i = 0; i < lineCount; i++) {
        if (siteAssetId) {
          var lineSiteAssetId = est.getSublistValue({
            sublistId: 'item',
            fieldId: EST_LINE.SITE_ASSET,
            line: i
          });
          if (String(lineSiteAssetId || '') !== String(siteAssetId || '')) continue;
        }

        var linkedSalesOrderId = normalizeRecordId(est.getSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.RELATED_SALES_ORDER,
          line: i
        }));

        if (linkedSalesOrderId && ensureSalesOrderHeaderLink(linkedSalesOrderId, estId, projectId)) {
          return linkedSalesOrderId;
        }
      }
    } catch (e) {
      log.audit({
        title: 'BC Sales Order Estimate line lookup skipped',
        details: JSON.stringify({
          estimateId: estId,
          projectId: projectId,
          siteAssetId: siteAssetId || '',
          error: getErrorDetails(e)
        })
      });
    }

    return '';
  }

  function ensureSalesOrderHeaderLink(salesOrderId, estId, projectId) {
    try {
      var salesOrder = record.load({
        type: record.Type.SALES_ORDER,
        id: salesOrderId,
        isDynamic: false
      });
      var existingProjectId = String(salesOrder.getValue({ fieldId: SO.PROJECT }) || '');
      var existingEstimateId = String(salesOrder.getValue({ fieldId: SO.SOURCE_ESTIMATE }) || '');

      if (existingProjectId && String(projectId || '') && existingProjectId !== String(projectId || '')) return false;
      if (existingEstimateId && String(estId || '') && existingEstimateId !== String(estId || '')) return false;

      var values = {};
      if (!existingProjectId && projectId) values[SO.PROJECT] = projectId;
      if (!existingEstimateId && estId) values[SO.SOURCE_ESTIMATE] = estId;

      if (Object.keys(values).length) {
        record.submitFields({
          type: record.Type.SALES_ORDER,
          id: salesOrderId,
          values: values,
          options: {
            enableSourcing: false,
            ignoreMandatoryFields: true
          }
        });
      }

      return true;
    } catch (e) {
      log.audit({
        title: 'BC Sales Order header link check skipped',
        details: JSON.stringify({
          salesOrderId: salesOrderId,
          estimateId: estId,
          projectId: projectId,
          error: getErrorDetails(e)
        })
      });
      return false;
    }
  }

  function setSalesOrderExternalId(salesOrder, estId, projectId) {
    var externalId = makeSalesOrderExternalId(estId, projectId);
    if (!externalId) return;

    try {
      salesOrder.setValue({ fieldId: 'externalid', value: externalId });
    } catch (e) {
      log.audit({
        title: 'BC Sales Order external ID skipped',
        details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) })
      });
    }
  }

  function makeSalesOrderExternalId(estId, projectId) {
    if (!estId || !projectId) return '';
    return sanitizeExternalId(['BC', 'SO', 'EST', estId, 'PRJ', projectId].join('_'));
  }

  function normalizeRecordId(value) {
    if (value === '' || value === null || value === undefined) return '';
    if (Array.isArray(value)) return normalizeRecordId(value[0]);
    if (typeof value === 'object') return normalizeRecordId(value.value || value.id || value.internalid || '');

    var match = String(value).match(/\d+/);
    return match ? match[0] : String(value);
  }

  function salesOrderHasProject(salesOrderId, projectId) {
    try {
      var salesOrder = record.load({
        type: record.Type.SALES_ORDER,
        id: salesOrderId,
        isDynamic: false
      });

      return String(salesOrder.getValue({ fieldId: SO.PROJECT }) || '') === String(projectId || '');
    } catch (e) {
      log.audit({
        title: 'BC Sales Order project lookup skipped',
        details: JSON.stringify({
          salesOrderId: salesOrderId,
          projectId: projectId,
          error: getErrorDetails(e)
        })
      });
      return false;
    }
  }

  function findExistingProjectTask(estId, projectId, title, staging, taskData) {
    var externalId = makeProjectTaskExternalId(estId, projectId, staging, taskData);
    var foundByExternalId = findExistingProjectTaskByExternalId(externalId);
    if (foundByExternalId) return foundByExternalId;

    if (!title) return '';

    var found = '';
    search.create({
      type: search.Type.PROJECT_TASK || 'projecttask',
      filters: [
        [TASK.SOURCE_ESTIMATE, 'anyof', estId],
        'AND',
        [TASK.PROJECT, 'anyof', projectId],
        'AND',
        [TASK.TITLE, 'is', title]
      ],
      columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
    }).run().each(function (result) {
      found = result.getValue({ name: 'internalid' });
      return false;
    });

    return found;
  }

  function findExistingProjectTaskByExternalId(externalId) {
    if (!externalId) return '';

    var found = '';
    try {
      search.create({
        type: search.Type.PROJECT_TASK || 'projecttask',
        filters: [['externalid', 'is', externalId]],
        columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
      }).run().each(function (result) {
        found = result.getValue({ name: 'internalid' });
        return false;
      });
    } catch (e) {
      log.audit({
        title: 'BC Project Task external ID search skipped',
        details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) })
      });
    }

    return found;
  }

  function setProjectTaskExternalId(projectTask, opts) {
    var externalId = makeProjectTaskExternalId(opts.estimateId, opts.projectId, opts.staging, opts.taskData);
    if (!externalId) return;

    try {
      projectTask.setValue({
        fieldId: 'externalid',
        value: externalId
      });
    } catch (e) {
      log.audit({
        title: 'BC Project Task external ID skipped',
        details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) })
      });
    }
  }

  function makeProjectTaskExternalId(estId, projectId, staging, taskData) {
    if (!estId || !projectId || !staging || !staging.id || !taskData || !taskData.__bcTaskIndex) return '';
    return sanitizeExternalId([
      'BC',
      'EST',
      estId,
      'PRJ',
      projectId,
      'STG',
      staging.id,
      'IDX',
      taskData.__bcTaskIndex
    ].join('_'));
  }

  function sanitizeExternalId(value) {
    return String(value || '').replace(/[^A-Za-z0-9_:-]/g, '_').substring(0, 99);
  }

  function makeProjectName(prefix, tranId) {
    return prefix + ' - Estimate ' + (tranId || '');
  }

  function setIfPresent(rec, fieldId, value) {
    if (value !== '' && value !== null && value !== undefined) {
      rec.setValue({ fieldId: fieldId, value: value });
    }
  }

  function setSublistIfPresent(rec, sublistId, fieldId, line, value) {
    if (value !== '' && value !== null && value !== undefined) {
      rec.setSublistValue({
        sublistId: sublistId,
        fieldId: fieldId,
        line: line,
        value: value
      });
    }
  }

  function ensureSalesOrderLineAmount(salesOrder, line, sourceLine) {
    var currentAmount = getSublistValueSafe(salesOrder, 'item', 'amount', line);
    sourceLine = sourceLine || {};
    if (sourceLine.forceAmount !== true && !isBlankValue(currentAmount)) return false;

    var quantity = toNumber(
      getSublistValueSafe(salesOrder, 'item', 'quantity', line) || sourceLine.quantity,
      1
    );
    var sourceAmount = sourceLine.amount;
    var sourceRate = sourceLine.rate;

    if (isBlankValue(sourceAmount) && !isBlankValue(sourceRate)) {
      sourceAmount = toNumber(sourceRate, 0) * quantity;
    }

    if (isBlankValue(sourceRate) && !isBlankValue(sourceAmount) && quantity) {
      sourceRate = toNumber(sourceAmount, 0) / quantity;
    }

    if (isBlankValue(sourceAmount)) sourceAmount = 0;
    if (isBlankValue(sourceRate)) sourceRate = quantity ? toNumber(sourceAmount, 0) / quantity : 0;

    try {
      salesOrder.setSublistValue({
        sublistId: 'item',
        fieldId: 'price',
        line: line,
        value: -1
      });
    } catch (ignorePriceLevel) {}

    setSublistIfPresent(salesOrder, 'item', 'rate', line, sourceRate.toFixed(2));
    setSublistIfPresent(salesOrder, 'item', 'amount', line, sourceAmount.toFixed(2));
    return true;
  }

  function getSublistValueSafe(rec, sublistId, fieldId, line) {
    try {
      return rec.getSublistValue({
        sublistId: sublistId,
        fieldId: fieldId,
        line: line
      });
    } catch (e) {
      return '';
    }
  }

  function toNumber(value, defaultValue) {
    var n = Number(String(value === null || value === undefined ? '' : value).replace(/,/g, ''));
    return isNaN(n) ? defaultValue : n;
  }

  function roundCurrency(value) {
    return Math.round(toNumber(value, 0) * 100) / 100;
  }

  function isMissing(value) {
    return value === '' || value === null || value === undefined;
  }

  function isBlankValue(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }

  function objectValues(obj) {
    var values = [];
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        values.push(obj[key]);
      }
    }
    return values;
  }

  function getErrorDetails(error) {
    if (!error) return {};

    return {
      name: error.name || '',
      message: error.message || String(error),
      id: error.id || '',
      type: error.type || '',
      stack: error.stack || ''
    };
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeJs(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n');
  }

  return { onRequest: onRequest };
});
