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
    TAX_CODE: 'taxcode'
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

  var TASK_ASSIGNEE = {
    SUBLIST: 'assignee',
    RESOURCE: 'resource',
    PLANNED_WORK: 'plannedwork',
    UNIT_COST: 'unitcost'
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
  var ROLLOUT_ASYNC_SITE_THRESHOLD = 10;
  var ROLLOUT_MR_SCRIPT_ID = 'customscript_bc_mr_rollout_generation';
  var ROLLOUT_MR_DEPLOY_NOW = 'customdeploy_bc_mr_rollout_gen_now';
  var ROLLOUT_MR_DEPLOY_SCHED = 'customdeploy_bc_mr_rollout_gen_sched';
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

  // SANDBOX TEST ONLY: set to false before moving beyond progress-bar testing.
  var PROGRESS_TEST_MODE = false;
  var PROGRESS_TEST_STANDARD_PROJECT_COUNT = 10;

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

  function getProjectProgress(est, estId) {
    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');
    var expected = getExpectedProjectCount(est);
    var expectedTasks = getExpectedProjectTaskCount(est, estId);
    var expectedSalesOrders = getExpectedSalesOrderCount(est);
    var projects = getGeneratedProjects(estId);
    var tasks = getGeneratedProjectTasks(estId);
    var salesOrders = getGeneratedSalesOrders(estId);
    var created = projects.length;
    var createdTotal = projects.length + tasks.length + salesOrders.length;
    var expectedTotal = expected + expectedTasks + expectedSalesOrders;
    var percent = expected > 0 ? Math.min(100, Math.round((created / expected) * 100)) : 0;
    var totalPercent = expectedTotal > 0 ? Math.min(100, Math.round((createdTotal / expectedTotal) * 100)) : 0;
    var taskPercent = expectedTasks > 0 ? Math.min(100, Math.round((tasks.length / expectedTasks) * 100)) : 0;
    var salesOrderPercent = expectedSalesOrders > 0 ? Math.min(100, Math.round((salesOrders.length / expectedSalesOrders) * 100)) : 0;
    var generated = est.getValue(EST.PROJECT_GENERATED) === true;
    var generationStatus = String(est.getValue(EST.GENERATION_STATUS) || '');
    var errorDetails = readGenerationErrorDetails(est);
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

  function getExpectedProjectCount(est) {
    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      return PROGRESS_TEST_MODE ? PROGRESS_TEST_STANDARD_PROJECT_COUNT : 1;
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
    var taskStatus = getTaskProgressStatus(progress.expectedTasks, progress.createdTasks);
    var taskHierarchy = buildTaskHierarchyHtml(progress.projects, progress.tasks);
    var salesOrderStatus = getSalesOrderProgressStatus(progress.expectedSalesOrders, progress.createdSalesOrders);
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
        '<td>' + (err.retryable === false ? '<span class="muted">Blocked</span>' : '<button type="button" class="mini" onclick="bcRetryOne(\'' + escapeJs(err.key || '') + '\')">Retry</button>') + '</td>' +
      '</tr>';
    }).join('') : '<tr><td colspan="5">No saved errors found.</td></tr>';
    var retryAllButton = progress.errors.length ?
      '<button type="button" class="primary" onclick="bcRetryAll()">Retry Failed / Blocked</button>' : '';
    var retryRemainingButton = shouldShowRetryRemaining(progress) ?
      '<button type="button" class="primary secondary-action" onclick="bcRetryRemaining()">Retry Remaining</button>' : '';

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
      '.mini{padding:3px 7px;font-size:11px;}' +
      '.muted{color:#6b7280;font-size:11px;}' +
      '</style></head><body><div class="wrap">' +
      '<script>' +
      'function bcRetryOne(key){if(!key)return;var u=new URL(window.location.href);u.searchParams.set("action","retry");u.searchParams.set("key",key);window.location.href=u.toString();}' +
      'function bcRetryAll(){var u=new URL(window.location.href);u.searchParams.set("action","retry_all");u.searchParams.delete("key");window.location.href=u.toString();}' +
      'function bcRetryRemaining(){var u=new URL(window.location.href);u.searchParams.set("action","retry_remaining");u.searchParams.delete("key");window.location.href=u.toString();}' +
      '</script>' +
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
      '<div class="bar"><div class="fill" style="background:' + getTaskBarColor(progress.expectedTasks, progress.createdTasks) + ';width:' + progress.taskPercent + '%;"></div></div>' +
      '<div>Project Tasks created: <strong>' + progress.createdTasks + '</strong> of <strong>' + progress.expectedTasks + '</strong> (' + progress.taskPercent + '%)</div>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Expected Tasks</div><div class="value">' + progress.expectedTasks + '</div></div>' +
        '<div class="box"><div class="label">Created Tasks</div><div class="value">' + progress.createdTasks + '</div></div>' +
        '<div class="box"><div class="label">Remaining Tasks</div><div class="value">' + progress.remainingTasks + '</div></div>' +
        '<div class="box"><div class="label">Task Status</div><div class="value">' + escapeHtml(taskStatus) + '</div></div>' +
        '<div class="box"><div class="label">Task Source</div><div class="value">CPQ</div></div>' +
      '</div>' +
      '<h3>Sales Order Progress</h3>' +
      '<div class="bar"><div class="fill" style="background:' + getSalesOrderBarColor(progress.expectedSalesOrders, progress.createdSalesOrders) + ';width:' + progress.salesOrderPercent + '%;"></div></div>' +
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

  function getTaskProgressStatus(expected, created) {
    if (!expected) return 'No Tasks Expected';
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

  function getTaskBarColor(expected, created) {
    if (!expected) return '#94a3b8';
    if (created >= expected) return '#059669';
    if (created > 0) return '#2563eb';
    return '#94a3b8';
  }

  function isOverallProgressComplete(progress) {
    var projectsComplete = progress.expected > 0 && progress.created >= progress.expected;
    var tasksComplete = progress.expectedTasks === 0 || progress.createdTasks >= progress.expectedTasks;
    var salesOrdersComplete = progress.expectedSalesOrders === 0 || progress.createdSalesOrders >= progress.expectedSalesOrders;

    return projectsComplete && tasksComplete && salesOrdersComplete;
  }

  function getSalesOrderProgressStatus(expected, created) {
    if (!expected) return 'No Sales Orders Expected';
    if (created >= expected) return 'Complete';
    if (created > 0) return 'Processing / Partial';
    return 'Not Started';
  }

  function getSalesOrderBarColor(expected, created) {
    if (!expected) return '#94a3b8';
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

    if (!opts.allowExistingGeneratedRecords && !PROGRESS_TEST_MODE && hasExistingGeneratedProjects(estId)) {
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
    return runStandardGenerationFlow(est, estId, { initialRun: true });
  }

  function runStandardGenerationFlow(est, estId, opts) {
    opts = opts || {};
    var targetCount = PROGRESS_TEST_MODE ? PROGRESS_TEST_STANDARD_PROJECT_COUNT : 1;
    var projectIds = [];
    var errors = [];
    var projectId = findExistingStandardProject(estId);

    if (projectId) {
      projectIds.push(projectId);
    } else {
      for (var i = 0; i < targetCount; i++) {
        var attempt = {
          estimate: est,
          estimateId: estId,
          parentId: est.getValue(EST.ENTITY),
          siteAssetId: est.getValue(EST.SITE_ASSET),
          namePrefix: targetCount > 1 ? 'Progress Test Project ' + padNumber(i + 1) : 'Project',
          attemptLabel: targetCount > 1 ? 'Standard Project ' + padNumber(i + 1) : 'Standard Project',
          errorType: 'Project',
          errorKey: 'project:standard'
        };

        var result = tryCreateProject(attempt);
        if (result.projectId) projectIds.push(result.projectId);
        if (result.projectId && !projectId) projectId = result.projectId;
        if (result.error) errors.push(result.error);
      }
    }

    if (errors.length) {
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'STANDARD',
        expectedProjectCount: targetCount,
        projectIds: projectIds,
        projectErrors: errors,
        note: 'Standard Project generation completed with errors. Review the failed attempts, fix the data, and re-run as needed.'
      });
    }

    var taskResult = createProjectTasksForEstimate(est, estId, function () {
      return projectId;
    });

    if (taskResult.errors.length) {
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'STANDARD',
        expectedProjectCount: targetCount,
        expectedTaskCount: taskResult.expectedTaskCount,
        projectIds: projectIds,
        taskIds: taskResult.taskIds,
        taskErrors: taskResult.errors,
        salesOrderErrors: [makeBlockedError({
          key: 'blocked:so:standard',
          type: 'Blocked Sales Order',
          label: 'Standard Sales Order',
          message: 'Blocked until failed Project Task records are corrected and retried.',
          blockedBy: 'Project Task'
        })],
        warnings: taskResult.warnings,
        note: 'Standard Project was created, but one or more Project Tasks failed. Review the Project Task errors.'
      });
    }

    var salesOrderResult;
    try {
      salesOrderResult = createStandardSalesOrderFromEstimate(estId, projectId);
    } catch (salesOrderError) {
      return buildPartialFailureResult({
        estimateId: estId,
        flowType: 'STANDARD',
        expectedProjectCount: targetCount,
        expectedTaskCount: taskResult.expectedTaskCount,
        projectIds: projectIds,
        taskIds: taskResult.taskIds,
        salesOrderIds: salesOrderError.salesOrderId ? [salesOrderError.salesOrderId] : [],
        salesOrderErrors: [makeSalesOrderError('Standard Sales Order', salesOrderError.message || String(salesOrderError), {
          key: 'so:standard'
        })],
        warnings: taskResult.warnings,
        note: 'Standard Project and Project Tasks were created, but Sales Order creation failed.'
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
      testMode: PROGRESS_TEST_MODE,
      note: PROGRESS_TEST_MODE ?
        'Progress test mode created ' + projectIds.length + ' Standard Projects. Turn off test mode after validation.' :
        'Standard Project, Project Tasks, and Sales Order created.'
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
      return runStandardGenerationFlow(est, estId, { retryKey: key });
    }

    if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
      return runRolloutGenerationFlow(est, estId, getUniqueLineSites(est), { retryKey: key });
    }

    throw new Error('Unsupported or missing Estimate Type. Expected Standard (1) or Rollout (2).');
  }

  function retryAllGeneration(est, estId) {
    validateEstimate(est, estId, {
      allowExistingGeneratedRecords: true,
      allowCompleted: true
    });

    var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

    if (estimateType === ESTIMATE_TYPE_STANDARD) {
      setGenerationStatus(estId, GEN_STATUS.PROCESSING, { generated: false });
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
    var salesOrderResult = createRolloutSalesOrdersFromEstimate(est, estId, sites, childProjectBySite, taskErrorSites);
    var salesOrderErrors = salesOrderResult.errors || [];

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
        taskErrors: taskResult.errors,
        salesOrderErrors: salesOrderErrors,
        siteCount: sites.length,
        warnings: taskResult.warnings,
        note: 'Rollout generation completed with errors. Successful Projects, Project Tasks, and Sales Orders were left in place for review.'
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

      var salesOrder = record.transform({
        fromType: record.Type.ESTIMATE,
        fromId: estId,
        toType: record.Type.SALES_ORDER,
        isDynamic: false
      });

      salesOrder.setValue({ fieldId: SO.PROJECT, value: projectId });
      salesOrder.setValue({ fieldId: SO.SOURCE_ESTIMATE, value: estId });

      var lineCount = salesOrder.getLineCount({ sublistId: 'item' }) || 0;
      var expandedKitCount = expandKitLinesOnSalesOrder(salesOrder, projectId);
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
    var est = record.load({
      type: record.Type.ESTIMATE,
      id: estId,
      isDynamic: false
    });
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;
    var updated = 0;

    for (var i = 0; i < lineCount; i++) {
      var itemId = est.getSublistValue({
        sublistId: 'item',
        fieldId: 'item',
        line: i
      });

      if (!itemId) continue;
      if (siteAssetId) {
        var lineSiteAssetId = est.getSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.SITE_ASSET,
          line: i
        });

        if (String(lineSiteAssetId || '') !== String(siteAssetId)) continue;
      }

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
    var existingSalesOrderId = findExistingSalesOrderForProject(estId, projectId);
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
      salesOrder.setValue({ fieldId: SO.PROJECT, value: projectId });
      salesOrder.setValue({ fieldId: SO.SOURCE_ESTIMATE, value: estId });

      for (var i = 0; i < lines.length; i++) {
        salesOrder.setSublistValue({
          sublistId: 'item',
          fieldId: 'item',
          line: i,
          value: lines[i].itemId
        });
        setSublistIfPresent(salesOrder, 'item', 'quantity', i, lines[i].quantity);
        setSublistIfPresent(salesOrder, 'item', 'department', i, lines[i].department);
        setSublistIfPresent(salesOrder, 'item', 'class', i, lines[i].classId);
        setSublistIfPresent(salesOrder, 'item', 'location', i, lines[i].location);
        setSublistIfPresent(salesOrder, 'item', EST_LINE.TAX_CODE, i, lines[i].taxCode);
        ensureSalesOrderLineAmount(salesOrder, i, lines[i]);
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
        var components = getKitComponents(itemId);
        var componentLines = allocateKitComponentLines(components, quantity, sourceAmount, sourceRate);

        for (var c = 0; c < componentLines.length; c++) {
          lines.push({
            itemId: componentLines[c].itemId,
            quantity: componentLines[c].quantity,
            rate: componentLines[c].rate,
            amount: componentLines[c].amount,
            forceAmount: true,
            department: baseLine.department,
            classId: baseLine.classId,
            location: baseLine.location,
            taxCode: baseLine.taxCode
          });
        }
      } else {
        lines.push(baseLine);
      }
    }

    return lines;
  }

  function expandKitLinesOnSalesOrder(salesOrder, projectId) {
    var expanded = 0;
    var lineCount = salesOrder.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = lineCount - 1; i >= 0; i--) {
      var itemId = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
      var itemType = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: i });

      if (!itemId || !isKitItemType(itemType)) continue;

      var quantity = toNumber(salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }), 1);
      var sourceRate = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: i });
      var sourceAmount = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'amount', line: i });
      var department = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'department', line: i });
      var classId = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'class', line: i });
      var location = salesOrder.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i });
      var taxCode = salesOrder.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.TAX_CODE, line: i });
      var components = getKitComponents(itemId);
      var componentLines = allocateKitComponentLines(components, quantity, sourceAmount, sourceRate);

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
        salesOrder.setSublistValue({ sublistId: 'item', fieldId: SO.PROJECT, line: i, value: projectId });
      }

      expanded++;
    }

    return expanded;
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

    addProjectTaskAssignee(task, opts, taskData);

    try {
      log.audit({
        title: 'BC Project Task save attempt',
        details: JSON.stringify({
          estimateId: opts.estimateId,
          projectId: opts.projectId,
          stagingId: opts.staging.id,
          title: taskData.title || '',
          resource: getProjectTaskResource(opts, taskData) || '',
          bodyEstimatedWork: taskData.estimatedwork || '',
          bodyPlannedWork: taskData.plannedwork || '',
          assigneePlannedWork: getProjectTaskAssigneePlannedWork(taskData),
          assigneeUnitCost: getProjectTaskAssigneeUnitCost(taskData)
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
          resource: getProjectTaskResource(opts, taskData) || '',
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
          assigneeFields: {
            plannedwork: getProjectTaskAssigneePlannedWork(taskData),
            unitcost: getProjectTaskAssigneeUnitCost(taskData)
          },
          error: getErrorDetails(saveError)
        })
      });
      throw saveError;
    }
  }

  function addProjectTaskAssignee(task, opts, taskData) {
    var resourceId = getProjectTaskResource(opts, taskData);
    var plannedWork = getProjectTaskAssigneePlannedWork(taskData);
    var unitCost = getProjectTaskAssigneeUnitCost(taskData);

    if (!resourceId) {
      throw new Error(
        'No Project Task resource found. Populate Estimate Project Manager or pass resource in the CPQ task JSON.'
      );
    }

    log.audit({
      title: 'BC Project Task assignee line attempt',
      details: JSON.stringify({
        estimateId: opts.estimateId,
        projectId: opts.projectId,
        stagingId: opts.staging.id,
        title: taskData.title || '',
        sublistId: TASK_ASSIGNEE.SUBLIST,
        resourceField: TASK_ASSIGNEE.RESOURCE,
        resource: resourceId,
        plannedWorkField: TASK_ASSIGNEE.PLANNED_WORK,
        plannedWork: plannedWork,
        unitCostField: TASK_ASSIGNEE.UNIT_COST,
        unitCost: unitCost
      })
    });

    task.selectNewLine({ sublistId: TASK_ASSIGNEE.SUBLIST });
    task.setCurrentSublistValue({
      sublistId: TASK_ASSIGNEE.SUBLIST,
      fieldId: TASK_ASSIGNEE.RESOURCE,
      value: resourceId
    });

    setCurrentTaskAssigneeField(
      task,
      TASK_ASSIGNEE.PLANNED_WORK,
      plannedWork
    );
    setCurrentTaskAssigneeField(
      task,
      TASK_ASSIGNEE.UNIT_COST,
      unitCost
    );

    task.commitLine({ sublistId: TASK_ASSIGNEE.SUBLIST });

    log.audit({
      title: 'BC Project Task assignee line committed',
      details: JSON.stringify({
        estimateId: opts.estimateId,
        projectId: opts.projectId,
        stagingId: opts.staging.id,
        title: taskData.title || '',
        resource: resourceId,
        plannedWork: plannedWork,
        unitCost: unitCost
      })
    });
  }

  function getProjectTaskResource(opts, taskData) {
    return (
      taskData.resource ||
      taskData.assignee ||
      taskData.projectresource ||
      opts.estimate.getValue(EST.PROJECTMANAGER)
    );
  }

  function getProjectTaskAssigneePlannedWork(taskData) {
    return taskData.plannedwork || taskData.estimatedwork || taskData.duration || 0;
  }

  function getProjectTaskAssigneeUnitCost(taskData) {
    return taskData.unitcost || taskData.cost || taskData.resourcecost || 0;
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

  function setCurrentTaskAssigneeField(task, fieldId, value) {
    if (value === '' || value === null || value === undefined) return;

    task.setCurrentSublistValue({
      sublistId: TASK_ASSIGNEE.SUBLIST,
      fieldId: fieldId,
      value: value
    });
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
    var success = result.success === true;
    var partial = result.partial === true;
    var statusText = success ? 'Complete' : partial ? 'Completed with Errors' : 'Failed';
    var barColor = success ? '#059669' : partial ? '#d97706' : '#dc2626';
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

  function findExistingSalesOrderForProject(estId, projectId) {
    var found = '';

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
        found = salesOrderId;
        return false;
      }

      return true;
    });

    return found;
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

  function padNumber(value) {
    return value < 10 ? '0' + value : String(value);
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

    setSublistIfPresent(salesOrder, 'item', 'rate', line, sourceRate);
    setSublistIfPresent(salesOrder, 'item', 'amount', line, sourceAmount);
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
