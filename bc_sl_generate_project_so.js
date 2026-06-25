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
define(['N/record', 'N/search', 'N/log', 'N/format'], function (record, search, log, format) {

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
    GENERATED_PROJECT: 'custbody_bc_project'
  };

  // ---- Estimate line field IDs --------------------------------------------
  var EST_LINE = {
    SITE_ASSET: 'custcol_nx_asset',
    STAGING_IDS: 'custcol_nscpq_proj_task_staging_ids'
  };

  // ---- CPQ Project Task Staging field IDs ------------------------------------
  var STAGING = {
    TYPE: 'customrecord_nscpq_task_staging',
    NAME: 'name',
    STATUS: 'custrecord_task_status',
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
    ESTIMATED_WORK: 'estimatedwork'
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

  var APPROVED_STATUS_VALUE = '2';
  var ESTIMATE_TYPE_STANDARD = '1';
  var ESTIMATE_TYPE_ROLLOUT = '2';
  var FIXED_FEE_PROJECT_TYPE = '18';

  // SANDBOX TEST ONLY: set to false before moving beyond progress-bar testing.
  var PROGRESS_TEST_MODE = false;
  var PROGRESS_TEST_STANDARD_PROJECT_COUNT = 10;
  var STAGING_STATUS_STAGED = 'staged';
  var STAGING_STATUS_TEST = 'Test';
  var STAGING_STATUS_PROCESSED = 'Processed';
  var STAGING_STATUS_FAILED = 'failed';

  function onRequest(ctx) {
    var out = { success: false };

    try {
      var estId = ctx.request.parameters.estid;
      if (!estId) throw new Error('Missing estid parameter.');

      if (ctx.request.parameters.action === 'progress') {
        writeProjectProgressPage(ctx, estId);
        return;
      }

      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });

      validateEstimate(est, estId);

      var estimateType = String(est.getValue(EST.ESTIMATE_TYPE) || '');

      if (estimateType === ESTIMATE_TYPE_STANDARD) {
        out = runStandardProjectCreation(est, estId);
      } else if (estimateType === ESTIMATE_TYPE_ROLLOUT) {
        out = runRolloutProjectCreation(est, estId);
      } else {
        throw new Error('Unsupported or missing Estimate Type. Expected Standard (1) or Rollout (2).');
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
    var projects = getGeneratedProjects(estId);
    var tasks = getGeneratedProjectTasks(estId);
    var created = projects.length;
    var percent = expected > 0 ? Math.min(100, Math.round((created / expected) * 100)) : 0;
    var taskPercent = expectedTasks > 0 ? Math.min(100, Math.round((tasks.length / expectedTasks) * 100)) : 0;
    var generated = est.getValue(EST.PROJECT_GENERATED) === true;
    var status = getProjectProgressStatusDetails(expected, created, generated);

    return {
      estimateId: estId,
      estimateTranId: est.getValue(EST.TRANID),
      estimateType: estimateType,
      expected: expected,
      created: created,
      remaining: Math.max(expected - created, 0),
      percent: percent,
      expectedTasks: expectedTasks,
      createdTasks: tasks.length,
      remainingTasks: Math.max(expectedTasks - tasks.length, 0),
      taskPercent: taskPercent,
      generated: generated,
      statusCode: status.code,
      statusText: status.text,
      projects: projects,
      tasks: tasks
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

  function buildProjectProgressPage(progress) {
    var complete = progress.statusCode === 'COMPLETE';
    var refresh = complete ? '' : '<meta http-equiv="refresh" content="2">';
    var warning = progress.statusCode === 'WARNING' ?
      '<div class="warn">The Estimate is marked generated, but the Project count does not match the expected count. Review the generated Projects before re-running.</div>' : '';
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

    return '<!doctype html>' +
      '<html><head><title>Project Progress</title>' + refresh +
      '<style>' +
      'body{font-family:Arial,sans-serif;margin:24px;color:#1f2937;background:#f8fafc;}' +
      '.wrap{max-width:980px;margin:0 auto;background:#fff;border:1px solid #d9e2ec;padding:20px;}' +
      '.bar{height:18px;background:#e5e7eb;border-radius:9px;overflow:hidden;margin:14px 0;}' +
      '.fill{height:18px;background:' + getBarColor(progress.statusCode) + ';width:' + progress.percent + '%;}' +
      '.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:18px 0;}' +
      '.box{border:1px solid #e5e7eb;background:#f9fafb;padding:12px;}' +
      '.label{font-size:12px;color:#6b7280;text-transform:uppercase;}' +
      '.value{font-size:20px;font-weight:700;margin-top:4px;}' +
      '.warn{border:1px solid #f59e0b;background:#fffbeb;color:#92400e;padding:10px;margin:12px 0;}' +
      'table{width:100%;border-collapse:collapse;margin-top:16px;}' +
      'th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;}' +
      'th{background:#f3f4f6;}' +
      '</style></head><body><div class="wrap">' +
      '<h2>Project Generation Progress</h2>' +
      '<div>Estimate: ' + escapeHtml(progress.estimateTranId || progress.estimateId) + '</div>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<div>Projects created: <strong>' + progress.created + '</strong> of <strong>' + progress.expected + '</strong> (' + progress.percent + '%)</div>' +
      warning +
      '<h3>Project Progress</h3>' +
      '<div class="summary">' +
        '<div class="box"><div class="label">Flow</div><div class="value">' + escapeHtml(getEstimateTypeLabel(progress.estimateType)) + '</div></div>' +
        '<div class="box"><div class="label">Expected</div><div class="value">' + progress.expected + '</div></div>' +
        '<div class="box"><div class="label">Created</div><div class="value">' + progress.created + '</div></div>' +
        '<div class="box"><div class="label">Remaining</div><div class="value">' + progress.remaining + '</div></div>' +
        '<div class="box"><div class="label">Status</div><div class="value">' + escapeHtml(progress.statusText) + '</div></div>' +
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
      '<h3>Generated Projects</h3>' +
      '<table><thead><tr><th>Internal ID</th><th>Name / ID</th><th>Parent</th><th>Site</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<h3>Project Task Hierarchy</h3>' +
      taskHierarchy +
      '<p style="color:#6b7280;margin-top:16px;">This page refreshes automatically until all expected Project records are found.</p>' +
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

  function getTaskBarColor(expected, created) {
    if (!expected) return '#94a3b8';
    if (created >= expected) return '#059669';
    if (created > 0) return '#2563eb';
    return '#94a3b8';
  }

  function getProjectProgressStatusDetails(expected, created, generated) {
    if (!expected) return { code: 'WAITING', text: 'Waiting' };
    if (created >= expected) return { code: 'COMPLETE', text: 'Complete' };
    if (generated && created < expected) return { code: 'WARNING', text: 'Warning' };
    if (created > 0) return { code: 'PROCESSING', text: 'Processing / Partial' };
    return { code: 'NOT_STARTED', text: 'Not Started' };
  }

  function getBarColor(statusCode) {
    if (statusCode === 'COMPLETE') return '#059669';
    if (statusCode === 'WARNING') return '#d97706';
    if (statusCode === 'PROCESSING') return '#2563eb';
    return '#94a3b8';
  }

  function getEstimateTypeLabel(value) {
    if (value === ESTIMATE_TYPE_STANDARD) return 'Standard';
    if (value === ESTIMATE_TYPE_ROLLOUT) return 'Rollout';
    return 'Missing';
  }

  function validateEstimate(est, estId) {
    if (String(est.getValue(EST.APPROVAL_STATUS)) !== APPROVED_STATUS_VALUE) {
      throw new Error('Estimate is not in customer-approved status.');
    }

    if (est.getValue(EST.PROJECT_GENERATED) === true) {
      throw new Error('Project already generated for this estimate.');
    }

    if (!PROGRESS_TEST_MODE && hasExistingGeneratedProjects(estId)) {
      throw new Error('Project records already exist for this estimate. Delete or review them before re-running.');
    }

    if (!est.getValue(EST.PROJECT_END)) {
      throw new Error('Estimated End Date is required before creating Project records.');
    }
  }

  function runStandardProjectCreation(est, estId) {
    var targetCount = PROGRESS_TEST_MODE ? PROGRESS_TEST_STANDARD_PROJECT_COUNT : 1;
    var projectIds = [];
    var errors = [];

    for (var i = 0; i < targetCount; i++) {
      var attempt = {
        estimate: est,
        estimateId: estId,
        parentId: est.getValue(EST.ENTITY),
        siteAssetId: est.getValue(EST.SITE_ASSET),
        namePrefix: targetCount > 1 ? 'Progress Test Project ' + padNumber(i + 1) : 'Project',
        attemptLabel: targetCount > 1 ? 'Standard Project ' + padNumber(i + 1) : 'Standard Project'
      };

      var result = tryCreateProject(attempt);
      if (result.projectId) projectIds.push(result.projectId);
      if (result.error) errors.push(result.error);
    }

    var projectId = projectIds[0];

    if (errors.length) {
      return buildPartialFailureResult({
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
        flowType: 'STANDARD',
        expectedProjectCount: targetCount,
        expectedTaskCount: taskResult.expectedTaskCount,
        projectIds: projectIds,
        taskIds: taskResult.taskIds,
        taskErrors: taskResult.errors,
        warnings: taskResult.warnings,
        note: 'Standard Project was created, but one or more Project Tasks failed. Review the failed staging records.'
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
      warnings: taskResult.warnings,
      testMode: PROGRESS_TEST_MODE,
      note: PROGRESS_TEST_MODE ?
        'Progress test mode created ' + projectIds.length + ' Standard Projects. Turn off test mode after validation.' :
        'Standard Project and Project Tasks created. Sales Order is pending a later phase.'
    };
  }

  function runRolloutProjectCreation(est, estId) {
    var sites = getUniqueLineSites(est);
    if (!sites.length) {
      throw new Error('Rollout Estimate has no unique line-level Site Assets in ' + EST_LINE.SITE_ASSET + '.');
    }

    var errors = [];
    var parentProjectId;
    var parentResult = tryCreateProject({
      estimate: est,
      estimateId: estId,
      parentId: est.getValue(EST.ENTITY),
      siteAssetId: null,
      namePrefix: 'Rollout Parent',
      attemptLabel: 'Rollout Parent Project'
    });

    if (parentResult.projectId) parentProjectId = parentResult.projectId;
    if (parentResult.error) errors.push(parentResult.error);

    var childProjectIds = [];
    var childProjectBySite = {};
    if (parentProjectId) {
      for (var i = 0; i < sites.length; i++) {
        var childResult = tryCreateProject({
          estimate: est,
          estimateId: estId,
          parentId: parentProjectId,
          siteAssetId: sites[i].id,
          siteText: sites[i].text,
          namePrefix: 'Rollout Site ' + (sites[i].text || sites[i].id),
          attemptLabel: 'Rollout Child Project for Site ' + (sites[i].text || sites[i].id)
        });

        if (childResult.projectId) childProjectIds.push(childResult.projectId);
        if (childResult.projectId) childProjectBySite[String(sites[i].id)] = childResult.projectId;
        if (childResult.error) errors.push(childResult.error);
      }
    } else {
      for (var s = 0; s < sites.length; s++) {
        errors.push({
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

    if (errors.length || taskResult.errors.length) {
      var allProjectIds = parentProjectId ? [parentProjectId].concat(childProjectIds) : childProjectIds;
      return buildPartialFailureResult({
        flowType: 'ROLLOUT',
        parentProjectId: parentProjectId,
        childProjectIds: childProjectIds,
        projectIds: allProjectIds,
        expectedProjectCount: sites.length + 1,
        expectedTaskCount: taskResult.expectedTaskCount,
        taskIds: taskResult.taskIds,
        projectErrors: errors,
        taskErrors: taskResult.errors,
        siteCount: sites.length,
        warnings: taskResult.warnings,
        note: 'Rollout Project generation completed with errors. Successful Projects were left in place for review.'
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
      warnings: taskResult.warnings,
      note: 'Rollout parent, child projects, and Project Tasks created. Sales Orders are pending a later phase.'
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

  function createProjectTasksForEstimate(est, estId, resolveProjectId) {
    var stagingRecords = getTaskStagingRecordsForEstimate(est, estId, { logWarnings: true });
    var taskIds = [];
    var errors = [];
    var warnings = [];
    var expectedTaskCount = 0;

    for (var i = 0; i < stagingRecords.warnings.length; i++) {
      warnings.push(stagingRecords.warnings[i]);
    }

    for (var s = 0; s < stagingRecords.records.length; s++) {
      var staging = stagingRecords.records[s];
      var stagingFailed = false;
      var taskRows = [];

      if (!shouldProcessStagingStatus(staging.status)) {
        warnings.push('Skipped staging record ' + staging.id + ' because status is "' + (staging.status || 'blank') + '".');
        continue;
      }

      try {
        taskRows = parseTaskJson(staging.json, staging.id);
      } catch (jsonError) {
        stagingFailed = true;
        errors.push(makeTaskError(staging, null, jsonError.message || String(jsonError)));
      }

      expectedTaskCount += taskRows.length;

      for (var t = 0; t < taskRows.length; t++) {
        var taskData = taskRows[t];

        try {
          var projectId = resolveProjectId(staging, taskData);
          taskIds.push(createProjectTask({
            estimate: est,
            estimateId: estId,
            projectId: projectId,
            staging: staging,
            taskData: taskData
          }));
        } catch (taskError) {
          stagingFailed = true;
          errors.push(makeTaskError(staging, taskData, taskError.message || String(taskError)));
        }
      }

      updateStagingStatus(staging.id, stagingFailed ? STAGING_STATUS_FAILED : STAGING_STATUS_PROCESSED);
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

    setTaskField(task, TASK.TITLE, taskData.title);
    setTaskField(task, 'status', taskData.status);
    setTaskField(task, 'estimatedwork', taskData.estimatedwork);
    setTaskField(task, 'constrainttype', taskData.constrainttype);
    setTaskField(task, 'duration', taskData.duration);
    setTaskField(task, 'plannedwork', taskData.plannedwork);
    setTaskField(task, 'startdate', taskData.startdate);
    setTaskField(task, 'starttime', taskData.starttime);
    setTaskField(task, 'custevent_nx_task_type', taskData.custevent_nx_task_type);

    setTaskField(
      task,
      TASK.ASSET,
      taskData[TASK.ASSET] || opts.staging.siteAssetId || opts.estimate.getValue(EST.SITE_ASSET)
    );

    addProjectTaskAssignee(task, opts, taskData);

    return task.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  function addProjectTaskAssignee(task, opts, taskData) {
    var resourceId = getProjectTaskResource(opts, taskData);

    if (!resourceId) {
      throw new Error(
        'No Project Task resource found. Populate Estimate Project Manager or pass resource in the CPQ task JSON.'
      );
    }

    task.selectNewLine({ sublistId: TASK_ASSIGNEE.SUBLIST });
    task.setCurrentSublistValue({
      sublistId: TASK_ASSIGNEE.SUBLIST,
      fieldId: TASK_ASSIGNEE.RESOURCE,
      value: resourceId
    });

    setCurrentTaskAssigneeField(
      task,
      TASK_ASSIGNEE.ESTIMATED_WORK,
      taskData.estimatedwork || taskData.plannedwork || taskData.duration
    );

    task.commitLine({ sublistId: TASK_ASSIGNEE.SUBLIST });
  }

  function getProjectTaskResource(opts, taskData) {
    return (
      taskData.resource ||
      taskData.assignee ||
      taskData.projectresource ||
      opts.estimate.getValue(EST.PROJECTMANAGER)
    );
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

  function shouldProcessStagingStatus(status) {
    var value = String(status || '').toLowerCase();
    return value === STAGING_STATUS_STAGED.toLowerCase() ||
      value === STAGING_STATUS_TEST.toLowerCase();
  }

  function makeTaskError(staging, taskData, message) {
    return {
      type: 'Project Task',
      label: 'Staging Record ' + staging.id + (taskData && taskData.title ? ' - ' + taskData.title : ''),
      siteId: staging.siteAssetId || '',
      siteText: staging.siteText || '',
      lineRef: staging.lineRef || '',
      message: message
    };
  }

  function updateStagingStatus(stagingId, status) {
    try {
      var values = {};
      values[STAGING.STATUS] = status;

      record.submitFields({
        type: STAGING.TYPE,
        id: stagingId,
        values: values,
        options: {
          enableSourcing: true,
          ignoreMandatoryFields: true
        }
      });
    } catch (e) {
      log.error({
        title: 'Unable to update staging status ' + stagingId,
        details: e.message || String(e)
      });
    }
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
      records: objectValues(recordsById),
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
      search.createColumn({ name: STAGING.STATUS }),
      search.createColumn({ name: STAGING.JSON }),
      search.createColumn({ name: STAGING.LINE_REF })
    ];
  }

  function makeStagingRecordFromSearch(result, lineContext) {
    return {
      id: result.getValue({ name: 'internalid' }),
      name: result.getValue({ name: STAGING.NAME }),
      status: result.getValue({ name: STAGING.STATUS }),
      json: result.getValue({ name: STAGING.JSON }),
      lineRef: result.getValue({ name: STAGING.LINE_REF }) || lineContext.lineRef,
      lineIndex: lineContext.index,
      itemId: lineContext.itemId,
      itemText: lineContext.itemText,
      siteAssetId: lineContext.siteAssetId,
      siteText: lineContext.siteText
    };
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
    var warnings = opts.warnings || [];
    var allErrors = projectErrors.concat(taskErrors);
    var createdCount = opts.projectIds ? opts.projectIds.length : 0;
    var expectedCount = opts.expectedProjectCount || createdCount;

    return {
      success: false,
      partial: createdCount > 0,
      flowType: opts.flowType,
      parentProjectId: opts.parentProjectId,
      childProjectIds: opts.childProjectIds || [],
      projectIds: opts.projectIds || [],
      projectCount: createdCount,
      expectedProjectCount: expectedCount,
      taskIds: opts.taskIds || [],
      taskCount: opts.taskIds ? opts.taskIds.length : 0,
      expectedTaskCount: opts.expectedTaskCount || 0,
      failedProjectCount: projectErrors.length,
      failedTaskCount: taskErrors.length,
      siteCount: opts.siteCount,
      errors: allErrors,
      projectErrors: projectErrors,
      taskErrors: taskErrors,
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
      '</style></head><body><div class="wrap">' +
      '<h2>Project Generation Status</h2>' +
      '<div>Status: <strong>' + escapeHtml(statusText) + '</strong></div>' +
      '<div class="bar"><div class="fill"></div></div>' +
      '<div>' + escapeHtml(result.note || result.error || '') + '</div>' +
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
      '<h3>Generation Errors</h3>' +
      '<table><thead><tr><th>Attempt</th><th>Site / Line</th><th>Error</th></tr></thead><tbody>' + errorRows + '</tbody></table>' +
      '</div></body></html>';
  }

  function markEstimateGenerated(estId, projectId) {
    var values = {};
    values[EST.PROJECT_GENERATED] = true;
    values[EST.GENERATED_PROJECT] = projectId;

    record.submitFields({
      type: record.Type.ESTIMATE,
      id: estId,
      values: values
    });
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

  function objectValues(obj) {
    var values = [];
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        values.push(obj[key]);
      }
    }
    return values;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return { onRequest: onRequest };
});
