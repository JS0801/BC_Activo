/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Background processor for National Rollout Estimate generation.
 *
 * Script ID: customscript_bc_mr_rollout_generation
 * On-demand deployment: customdeploy_bc_mr_rollout_gen_now
 * Scheduled deployment: customdeploy_bc_mr_rollout_gen_sched
 */
define(['N/record', 'N/search', 'N/log', 'N/format', 'N/runtime'], function (record, search, log, format, runtime) {

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
    ESTIMATE_TYPE: 'custbody_bc_estimate_type',
    PROJECT_GENERATED: 'custbody_bc_project_generated',
    GENERATED_PROJECT: 'custbody_bc_project',
    GENERATION_STATUS: 'custbody_bc_generation_status',
    ERROR_DETAILS: 'custbody_bc_error_details'
  };

  var EST_LINE = {
    SITE_ASSET: 'custcol_nx_asset',
    STAGING_IDS: 'custcol_nscpq_proj_task_staging_ids',
    RELATED_SALES_ORDER: 'custcol_bc_related_sales_order',
    TAX_CODE: 'taxcode'
  };

  var STAGING = {
    TYPE: 'customrecord_nscpq_task_staging',
    NAME: 'name',
    JSON: 'custrecord_task_json',
    TRANSACTION: 'custrecord_task_transaction',
    LINE_REF: 'custrecord_task_line_ref'
  };

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

  var PROJ = {
    NAME: 'companyname',
    CUSTOMER_PARENT: 'parent',
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
    SOURCE_ESTIMATE: 'custentity_bc_source_estimate'
  };

  var SO = {
    PROJECT: 'job',
    SOURCE_ESTIMATE: 'custbody_bc_source_estimate'
  };

  var GEN_STATUS = {
    PENDING: '1',
    PROCESSING: '2',
    COMPLETED: '3',
    FAILED: '4',
    PARTIAL_ERROR: '5',
    RETRY_PENDING: '6'
  };

  var ESTIMATE_TYPE_ROLLOUT = '2';
  var FIXED_FEE_PROJECT_TYPE = '18';
  var MR_PARAM_ESTIMATE_ID = 'custscript_bc_rollout_estimate_id';

  function getInputData() {
    var estId = runtime.getCurrentScript().getParameter({ name: MR_PARAM_ESTIMATE_ID });
    if (estId) return buildSiteInputsForEstimate(estId);

    var inputs = [];

    search.create({
      type: search.Type.ESTIMATE || 'estimate',
      filters: [
        ['mainline', 'is', 'T'],
        'AND',
        [EST.ESTIMATE_TYPE, 'anyof', ESTIMATE_TYPE_ROLLOUT],
        'AND',
        [EST.PROJECT_GENERATED, 'is', 'F'],
        'AND',
        [
          [EST.GENERATION_STATUS, 'anyof', GEN_STATUS.PENDING],
          'OR',
          [EST.GENERATION_STATUS, 'anyof', GEN_STATUS.RETRY_PENDING]
        ]
      ],
      columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
    }).run().each(function (result) {
      inputs = inputs.concat(buildSiteInputsForEstimate(result.getValue({ name: 'internalid' })));
      return true;
    });

    return inputs;
  }

  function map(context) {
    var input = parseMapInput(context.value);
    var estId = input.estimateId;

    try {
      if (input.recordType === 'estimate_error') {
        context.write({
          key: estId,
          value: JSON.stringify({
            success: false,
            estimateId: estId,
            parentProjectId: input.parentProjectId || '',
            errors: input.errors || [],
            warnings: []
          })
        });
        return;
      }

      if (input.recordType === 'estimate_finalize') {
        context.write({
          key: estId,
          value: JSON.stringify({
            success: true,
            estimateId: estId,
            parentProjectId: input.parentProjectId || '',
            errors: [],
            warnings: []
          })
        });
        return;
      }

      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });

      var result = processRolloutSite(est, input);
      context.write({ key: estId, value: JSON.stringify(result) });
    } catch (e) {
      context.write({
        key: estId,
        value: JSON.stringify({
          success: false,
          estimateId: estId,
          parentProjectId: input.parentProjectId || '',
          siteId: input.siteId || '',
          siteText: input.siteText || '',
          errors: [{
            key: 'mr:site:' + estId + ':' + (input.siteId || 'estimate'),
            type: 'Map/Reduce',
            label: input.siteId ? 'Site ' + (input.siteText || input.siteId) : 'Rollout Background Processing',
            siteId: input.siteId || '',
            siteText: input.siteText || '',
            message: e.message || String(e)
          }],
          warnings: []
        })
      });
      log.error({
        title: 'BC Rollout MR site failed',
        details: JSON.stringify({ input: input, error: getErrorDetails(e) })
      });
    }
  }

  function reduce(context) {
    var estId = context.key;
    var parentProjectId = '';
    var childProjectIds = [];
    var taskIds = [];
    var salesOrderIds = [];
    var errors = [];
    var warnings = [];

    for (var i = 0; i < context.values.length; i++) {
      var result = JSON.parse(context.values[i] || '{}');
      if (result.parentProjectId && !parentProjectId) parentProjectId = result.parentProjectId;
      if (result.childProjectId) childProjectIds.push(result.childProjectId);
      if (result.taskIds && result.taskIds.length) taskIds = taskIds.concat(result.taskIds);
      if (result.salesOrderIds && result.salesOrderIds.length) salesOrderIds = salesOrderIds.concat(result.salesOrderIds);
      if (result.errors && result.errors.length) errors = errors.concat(result.errors);
      if (result.warnings && result.warnings.length) warnings = warnings.concat(result.warnings);
    }

    if (!parentProjectId) {
      try {
        var est = record.load({
          type: record.Type.ESTIMATE,
          id: estId,
          isDynamic: false
        });
        parentProjectId = findExistingRolloutParentProject(est, estId);
      } catch (ignoreParentLookup) {}
    }

    if (!parentProjectId) {
      errors.push({
        key: 'project:rollout-parent',
        type: 'Project',
        label: 'Rollout Parent Project',
        message: 'Parent Project was not found after all site processing completed.'
      });
    }

    if (errors.length) {
      persistGenerationErrors(
        estId,
        errors,
        warnings,
        hasAnyCreated(parentProjectId, childProjectIds, taskIds, salesOrderIds) ? GEN_STATUS.PARTIAL_ERROR : GEN_STATUS.FAILED
      );
    } else {
      markEstimateGenerated(estId, parentProjectId);
    }

    context.write({
      key: estId,
      value: JSON.stringify({
        success: errors.length === 0,
        parentProjectId: parentProjectId,
        childProjectIds: childProjectIds,
        taskIds: taskIds,
        salesOrderIds: salesOrderIds,
        errorCount: errors.length
      })
    });
  }

  function summarize(summary) {
    summary.mapSummary.errors.iterator().each(function (key, value) {
      log.error({ title: 'BC Rollout MR map error ' + key, details: value });
      return true;
    });

    summary.reduceSummary.errors.iterator().each(function (key, value) {
      log.error({ title: 'BC Rollout MR reduce error ' + key, details: value });
      return true;
    });
  }

  function buildSiteInputsForEstimate(estId) {
    try {
      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });

      setGenerationStatus(estId, GEN_STATUS.PROCESSING, { generated: false });

      var sites = getUniqueLineSites(est);
      if (!sites.length) {
        return [makeMapInput({
          recordType: 'estimate_error',
          estimateId: estId,
          errors: [{
            key: 'estimate:no-sites:' + estId,
            type: 'Rollout',
            label: 'Rollout Site Input',
            message: 'Rollout Estimate has no unique line-level Site Assets.'
          }]
        })];
      }

      var parentResult = ensureRolloutParentProject(est, estId);
      if (parentResult.errors.length) {
        return [makeMapInput({
          recordType: 'estimate_error',
          estimateId: estId,
          parentProjectId: parentResult.parentProjectId || '',
          errors: parentResult.errors
        })];
      }

      var inputs = [];
      var childProjectBySite = getExistingChildProjectsBySite(estId);
      for (var i = 0; i < sites.length; i++) {
        if (!siteNeedsProcessing(est, estId, sites[i], childProjectBySite[String(sites[i].id)])) continue;

        inputs.push(makeMapInput({
          recordType: 'site',
          estimateId: estId,
          parentProjectId: parentResult.parentProjectId,
          siteId: sites[i].id,
          siteText: sites[i].text || ''
        }));
      }

      if (!inputs.length) {
        inputs.push(makeMapInput({
          recordType: 'estimate_finalize',
          estimateId: estId,
          parentProjectId: parentResult.parentProjectId
        }));
      }

      return inputs;
    } catch (e) {
      return [makeMapInput({
        recordType: 'estimate_error',
        estimateId: estId,
        errors: [{
          key: 'estimate:input:' + estId,
          type: 'Map/Reduce Input',
          label: 'Build Site Inputs',
          message: e.message || String(e)
        }]
      })];
    }
  }

  function ensureRolloutParentProject(est, estId) {
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

    return {
      parentProjectId: parentProjectId,
      errors: errors
    };
  }

  function siteNeedsProcessing(est, estId, site, childProjectId) {
    if (!childProjectId) return true;

    var expectedTasks = getExpectedTaskCountForSite(est, estId, site.id);
    var createdTasks = getCreatedProjectTaskCountForProject(estId, childProjectId);
    if (createdTasks < expectedTasks) return true;

    if (!findExistingSalesOrderForProject(estId, childProjectId, site.id)) return true;

    return false;
  }

  function getExpectedTaskCountForSite(est, estId, siteId) {
    var stagingRecords = getTaskStagingRecordsForEstimate(est, estId, { siteId: siteId });
    var expected = 0;

    for (var i = 0; i < stagingRecords.records.length; i++) {
      try {
        expected += parseTaskJson(stagingRecords.records[i].json, stagingRecords.records[i].id).length;
      } catch (ignoreBadJson) {
        expected++;
      }
    }

    return expected;
  }

  function getCreatedProjectTaskCountForProject(estId, projectId) {
    return search.create({
      type: search.Type.PROJECT_TASK || 'projecttask',
      filters: [
        [TASK.SOURCE_ESTIMATE, 'anyof', estId],
        'AND',
        [TASK.PROJECT, 'anyof', projectId]
      ],
      columns: ['internalid']
    }).runPaged({ pageSize: 1 }).count;
  }

  function processRolloutSite(est, input) {
    var estId = input.estimateId;
    var site = {
      id: input.siteId,
      text: input.siteText || ''
    };

    if (!site.id) throw new Error('Missing Site Asset in Map/Reduce input.');

    var errors = [];
    var parentProjectId = input.parentProjectId || findExistingRolloutParentProject(est, estId);
    var childProjectBySite = getExistingChildProjectsBySite(estId);
    var childProjectId = childProjectBySite[String(site.id)];

    if (!parentProjectId) {
      errors.push({
        key: 'project:rollout-parent',
        type: 'Project',
        label: 'Rollout Parent Project',
        message: 'Parent Project was not found before processing Site ' + (site.text || site.id) + '.'
      });
    }

    if (parentProjectId && !childProjectId) {
      var childResult = tryCreateProject({
        estimate: est,
        estimateId: estId,
        parentId: parentProjectId,
        siteAssetId: site.id,
        siteText: site.text,
        namePrefix: 'Rollout Site ' + (site.text || site.id),
        attemptLabel: 'Rollout Child Project for Site ' + (site.text || site.id),
        errorKey: 'project:child:' + site.id
      });

      if (childResult.projectId) childProjectId = childResult.projectId;
      if (childResult.error) {
        errors.push(childResult.error);
        errors.push(makeBlockedError({
          key: 'blocked:task:site:' + site.id,
          type: 'Blocked Project Task',
          label: 'Project Tasks for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          message: 'Blocked because the child Project was not created.',
          blockedBy: childResult.error.key
        }));
        errors.push(makeBlockedError({
          key: 'blocked:so:site:' + site.id,
          type: 'Blocked Sales Order',
          label: 'Sales Order for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          message: 'Blocked because the child Project was not created.',
          blockedBy: childResult.error.key
        }));
      }
    }

    if (!childProjectId) {
      return {
        success: false,
        estimateId: estId,
        parentProjectId: parentProjectId,
        siteId: site.id,
        siteText: site.text,
        errors: errors,
        warnings: []
      };
    }

    var siteProjectMap = {};
    siteProjectMap[String(site.id)] = childProjectId;

    var taskResult = createProjectTasksForEstimate(est, estId, function () {
      return childProjectId;
    }, { siteId: site.id });

    var taskErrorSites = getErrorSiteMap(taskResult.errors);
    var taskRollback = rollbackSiteProjectForErrors(estId, childProjectId, site, taskResult.errors, {
      reason: 'Rollout Project Task generation failed.'
    });

    if (taskRollback.deletedProjectId) {
      childProjectId = '';
      delete siteProjectMap[String(site.id)];
      taskResult.taskIds = removeIds(taskResult.taskIds || [], taskRollback.deletedTaskIds);
    }

    var salesOrderResult = childProjectId ?
      createRolloutSalesOrdersFromEstimate(est, estId, [site], siteProjectMap, taskErrorSites) :
      { salesOrderIds: [], errors: [], estimateLinesUpdated: 0 };
    var salesOrderRollback = rollbackSiteProjectForErrors(estId, childProjectId, site, salesOrderResult.errors, {
      reason: 'Rollout Sales Order generation failed.'
    });

    if (salesOrderRollback.deletedProjectId) {
      childProjectId = '';
      taskResult.taskIds = removeIds(taskResult.taskIds || [], salesOrderRollback.deletedTaskIds);
      salesOrderResult.salesOrderIds = removeIds(salesOrderResult.salesOrderIds || [], salesOrderRollback.deletedSalesOrderIds);
    }

    var allErrors = errors
      .concat(taskResult.errors)
      .concat(taskRollback.errors)
      .concat(salesOrderResult.errors)
      .concat(salesOrderRollback.errors);

    return {
      success: allErrors.length === 0,
      estimateId: estId,
      parentProjectId: parentProjectId,
      childProjectId: childProjectId,
      siteId: site.id,
      siteText: site.text,
      taskIds: childProjectId ? taskResult.taskIds : [],
      salesOrderIds: salesOrderResult.salesOrderIds,
      errors: allErrors,
      warnings: (taskResult.warnings || []).concat(taskRollback.warnings).concat(salesOrderRollback.warnings)
    };
  }

  function parseMapInput(value) {
    if (!value) return {};
    try {
      return JSON.parse(value);
    } catch (e) {
      return {
        recordType: 'estimate_error',
        estimateId: getEstimateIdFromContext(value),
        errors: [{
          key: 'mr:input-parse:' + value,
          type: 'Map/Reduce Input',
          label: 'Parse Site Input',
          message: e.message || String(e)
        }]
      };
    }
  }

  function makeMapInput(input) {
    return JSON.stringify(input || {});
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
    project.setValue({ fieldId: PROJ.FS_CUSTOMER, value: est.getValue(EST.FSM_CUSTOMER) || est.getValue(EST.ENTITY) });

    return project.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  function tryCreateProject(opts) {
    try {
      return { projectId: createProject(opts), error: null };
    } catch (e) {
      var error = {
        key: opts.errorKey || 'project:' + (opts.siteAssetId || 'parent'),
        type: 'Project',
        label: opts.attemptLabel || opts.namePrefix || 'Project',
        siteId: opts.siteAssetId || '',
        siteText: opts.siteText || '',
        message: e.message || String(e)
      };
      log.error({ title: 'BC Rollout MR Project failed', details: JSON.stringify(error) });
      return { projectId: null, error: error };
    }
  }

  function createProjectTasksForEstimate(est, estId, resolveProjectId, opts) {
    opts = opts || {};
    var stagingRecords = getTaskStagingRecordsForEstimate(est, estId, opts);
    var taskIds = [];
    var errors = [];
    var warnings = stagingRecords.warnings || [];
    var expectedTaskCount = 0;
    var taskDateStateByProject = {};

    for (var s = 0; s < stagingRecords.records.length; s++) {
      var staging = stagingRecords.records[s];
      var taskRows = [];

      try {
        taskRows = parseTaskJson(staging.json, staging.id);
      } catch (jsonError) {
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
            continue;
          }

          taskIds.push(createProjectTask({
            estimate: est,
            estimateId: estId,
            projectId: projectId,
            staging: staging,
            taskData: taskData
          }));
        } catch (taskError) {
          errors.push(makeTaskError(staging, taskData, taskError.message || String(taskError)));
        }
      }
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
    var projectTask = record.create({ type: record.Type.PROJECT_TASK, isDynamic: true });

    projectTask.setValue({ fieldId: TASK.PROJECT, value: opts.projectId });
    projectTask.setValue({ fieldId: TASK.SOURCE_ESTIMATE, value: opts.estimateId });
    setProjectTaskExternalId(projectTask, opts);
    setTaskField(projectTask, TASK.TITLE, taskData.title);
    setTaskField(projectTask, 'status', taskData.status);
    setTaskField(projectTask, 'estimatedwork', taskData.estimatedwork);
    setTaskField(projectTask, 'constrainttype', taskData.constrainttype);
    setTaskField(projectTask, 'duration', taskData.duration);
    setTaskField(projectTask, 'plannedwork', taskData.plannedwork);
    setTaskField(projectTask, 'startdate', getProjectTaskStartDate(opts, taskData));
    setTaskField(projectTask, 'starttime', taskData.starttime);
    setTaskField(projectTask, 'custevent_nx_task_type', taskData.custevent_nx_task_type);
    setTaskField(projectTask, TASK.ASSET, taskData[TASK.ASSET] || opts.staging.siteAssetId || opts.estimate.getValue(EST.SITE_ASSET));
   // addProjectTaskAssignee(projectTask, opts, taskData);

    return projectTask.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  function addProjectTaskAssignee(projectTask, opts, taskData) {
    var resourceId = taskData.resource || taskData.assignee || taskData.projectresource || opts.estimate.getValue(EST.PROJECTMANAGER);
    if (!resourceId) throw new Error('No Project Task resource found. Populate Estimate Project Manager or pass resource in the CPQ task JSON.');

    projectTask.selectNewLine({ sublistId: TASK_ASSIGNEE.SUBLIST });
    projectTask.setCurrentSublistValue({ sublistId: TASK_ASSIGNEE.SUBLIST, fieldId: TASK_ASSIGNEE.RESOURCE, value: resourceId });
    setCurrentTaskAssigneeField(projectTask, TASK_ASSIGNEE.PLANNED_WORK, taskData.plannedwork || taskData.estimatedwork || taskData.duration || 0);
    setCurrentTaskAssigneeField(projectTask, TASK_ASSIGNEE.UNIT_COST, taskData.unitcost || taskData.cost || taskData.resourcecost || 0);
    projectTask.commitLine({ sublistId: TASK_ASSIGNEE.SUBLIST });
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
        errors.push({
          key: 'so:site:' + site.id,
          type: 'Sales Order',
          label: 'Sales Order for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          salesOrderId: e.salesOrderId || '',
          message: e.message || String(e)
        });
      }
    }

    return { salesOrderIds: salesOrderIds, errors: errors, estimateLinesUpdated: estimateLinesUpdated };
  }

  function createRolloutSalesOrderForSite(est, estId, site, projectId) {
    var existingSalesOrderId = findExistingSalesOrderForProject(estId, projectId, site.id);
    if (existingSalesOrderId) {
      return {
        salesOrderId: existingSalesOrderId,
        estimateLinesUpdated: updateEstimateLinesWithSalesOrder(estId, existingSalesOrderId, site.id),
        reused: true
      };
    }

    var lines = getSalesOrderLinesForSite(est, site.id);
    if (!lines.length) throw new Error('No Estimate item lines found for Site Asset ' + (site.text || site.id) + '.');

    var salesOrderId;
    var salesOrder = record.create({ type: record.Type.SALES_ORDER, isDynamic: false });

    try {
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
        salesOrder.setSublistValue({ sublistId: 'item', fieldId: 'item', line: i, value: lines[i].itemId });
        setSublistIfPresent(salesOrder, 'item', 'quantity', i, lines[i].quantity);
        setSublistIfPresent(salesOrder, 'item', 'department', i, lines[i].department);
        setSublistIfPresent(salesOrder, 'item', 'class', i, lines[i].classId);
        setSublistIfPresent(salesOrder, 'item', 'location', i, lines[i].location);
        setSublistIfPresent(salesOrder, 'item', EST_LINE.TAX_CODE, i, lines[i].taxCode);
        ensureSalesOrderLineAmount(salesOrder, i, lines[i]);
        salesOrder.setSublistValue({ sublistId: 'item', fieldId: SO.PROJECT, line: i, value: projectId });
      }

      salesOrderId = salesOrder.save({ enableSourcing: true, ignoreMandatoryFields: true });
      return {
        salesOrderId: salesOrderId,
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
      var lineDefaults = {
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
            department: lineDefaults.department,
            classId: lineDefaults.classId,
            location: lineDefaults.location,
            taxCode: lineDefaults.taxCode
          });
        }
      } else {
        lines.push({
          itemId: itemId,
          quantity: quantity,
          rate: sourceRate,
          amount: sourceAmount,
          department: lineDefaults.department,
          classId: lineDefaults.classId,
          location: lineDefaults.location,
          taxCode: lineDefaults.taxCode
        });
      }
    }

    return lines;
  }

  function getTaskStagingRecordsForEstimate(est, estId, opts) {
    var recordsById = {};
    var warnings = [];
    var lines = getEstimateLineTaskContexts(est);
    var ids = [];

    opts = opts || {};
    if (opts.siteId) {
      lines = filterLineContextsBySite(lines, opts.siteId);
    }

    for (var i = 0; i < lines.length; i++) {
      for (var idIndex = 0; idIndex < lines[i].stagingIds.length; idIndex++) {
        ids.push(lines[i].stagingIds[idIndex]);
      }
    }

    if (ids.length) addStagingRecordsByIds(recordsById, ids, lines);

    for (var l = 0; l < lines.length; l++) {
      if (lines[l].stagingIds.length) continue;

      var beforeCount = Object.keys(recordsById).length;
      addStagingRecordsByEstimateLine(recordsById, estId, lines[l]);
      if (beforeCount === Object.keys(recordsById).length) {
        warnings.push('No Project Task staging record found for Estimate line ' + lines[l].lineRef + ' (' + lines[l].itemText + ').');
      }
    }

    return { records: sortStagingRecords(objectValues(recordsById)), warnings: warnings };
  }

  function filterLineContextsBySite(lines, siteId) {
    var filtered = [];
    for (var i = 0; i < lines.length; i++) {
      if (String(lines[i].siteAssetId || '') === String(siteId || '')) {
        filtered.push(lines[i]);
      }
    }
    return filtered;
  }

  function getEstimateLineTaskContexts(est) {
    var lines = [];
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = 0; i < lineCount; i++) {
      var lineRef = est.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i }) || (i + 1);
      lines.push({
        index: i,
        lineRef: String(lineRef),
        itemId: est.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }),
        itemText: est.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || '',
        siteAssetId: est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i }),
        siteText: est.getSublistText({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i }) || '',
        stagingIds: parseStagingIds(est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.STAGING_IDS, line: i }))
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
      recordsById[String(id)] = makeStagingRecordFromSearch(result, lineByStagingId[String(id)] || {});
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
      if (siteId && !bySite[String(siteId)]) bySite[String(siteId)] = result.getValue({ name: 'internalid' });
      return true;
    });
    return bySite;
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
      log.audit({ title: 'BC Rollout MR task external ID search skipped', details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) }) });
    }

    return found;
  }

  function setProjectTaskExternalId(projectTask, opts) {
    var externalId = makeProjectTaskExternalId(opts.estimateId, opts.projectId, opts.staging, opts.taskData);
    if (!externalId) return;

    try {
      projectTask.setValue({ fieldId: 'externalid', value: externalId });
    } catch (e) {
      log.audit({ title: 'BC Rollout MR task external ID skipped', details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) }) });
    }
  }

  function makeProjectTaskExternalId(estId, projectId, staging, taskData) {
    if (!estId || !projectId || !staging || !staging.id || !taskData || !taskData.__bcTaskIndex) return '';
    return sanitizeExternalId(['BC', 'EST', estId, 'PRJ', projectId, 'STG', staging.id, 'IDX', taskData.__bcTaskIndex].join('_'));
  }

  function sanitizeExternalId(value) {
    return String(value || '').replace(/[^A-Za-z0-9_:-]/g, '_').substring(0, 99);
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
        title: 'BC Rollout MR Sales Order external ID lookup skipped',
        details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) })
      });
    }

    return found;
  }

  function findLinkedSalesOrderFromEstimateLines(estId, projectId, siteAssetId) {
    try {
      var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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
        title: 'BC Rollout MR Sales Order Estimate line lookup skipped',
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
        title: 'BC Rollout MR Sales Order header link check skipped',
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
        title: 'BC Rollout MR Sales Order external ID skipped',
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
        title: 'BC Rollout MR Sales Order project lookup skipped',
        details: JSON.stringify({
          salesOrderId: salesOrderId,
          projectId: projectId,
          error: getErrorDetails(e)
        })
      });
      return false;
    }
  }

  function updateEstimateLinesWithSalesOrder(estId, salesOrderId, siteAssetId) {
    try {
      return updateEstimateLinesWithSalesOrderStatic(estId, salesOrderId, siteAssetId);
    } catch (staticError) {
      log.error({
        title: 'BC Rollout MR Estimate line Sales Order static link failed',
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
    var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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

    est.save({ enableSourcing: true, ignoreMandatoryFields: true });
    return updated;
  }

  function updateEstimateLinesWithSalesOrderDynamic(estId, salesOrderId, siteAssetId, originalError) {
    var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: true });
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;
    var updated = 0;
    var lineErrors = [];

    for (var i = 0; i < lineCount; i++) {
      if (!shouldAttachSalesOrderToEstimateLine(est, i, siteAssetId)) continue;

      try {
        est.selectLine({ sublistId: 'item', line: i });
        est.setCurrentSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.RELATED_SALES_ORDER,
          value: salesOrderId,
          ignoreFieldChange: true
        });
        est.commitLine({ sublistId: 'item' });
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

    est.save({ enableSourcing: true, ignoreMandatoryFields: true });
    return updated;
  }

  function shouldAttachSalesOrderToEstimateLine(est, line, siteAssetId) {
    var itemId = est.getSublistValue({ sublistId: 'item', fieldId: 'item', line: line });
    if (!itemId) return false;

    if (!siteAssetId) return true;

    var lineSiteAssetId = est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: line });
    return String(lineSiteAssetId || '') === String(siteAssetId || '');
  }

  function markEstimateGenerated(estId, projectId) {
    setGenerationStatus(estId, GEN_STATUS.COMPLETED, {
      projectId: projectId,
      generated: true,
      errorDetails: null
    });
  }

  function setGenerationStatus(estId, statusValue, opts) {
    var values = {};
    opts = opts || {};
    values[EST.GENERATION_STATUS] = statusValue;
    if (opts.projectId !== undefined && opts.projectId !== null && opts.projectId !== '') values[EST.GENERATED_PROJECT] = opts.projectId;
    if (opts.generated !== undefined) values[EST.PROJECT_GENERATED] = opts.generated === true;
    if (opts.errorDetails !== undefined) values[EST.ERROR_DETAILS] = opts.errorDetails ? JSON.stringify(opts.errorDetails) : '';

    record.submitFields({
      type: 'estimate',
      id: estId,
      values: values,
      options: { enableSourcing: false, ignoreMandatoryFields: true }
    });
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

  function normalizeGenerationErrors(errors) {
    var normalized = [];
    var seen = {};
    for (var i = 0; i < (errors || []).length; i++) {
      var err = errors[i] || {};
      var key = err.key || [err.type || 'generation', err.siteId || err.lineRef || '', err.stagingId || '', err.taskIndex || '', i].join(':');
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
        salesOrderId: err.salesOrderId || '',
        blockedBy: err.blockedBy || '',
        retryable: err.retryable !== false,
        message: err.message || ''
      };
      normalized.push(seen[key]);
    }
    return normalized;
  }

  function getUniqueLineSites(est) {
    var seen = {};
    var sites = [];
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = 0; i < lineCount; i++) {
      var siteId = est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i });
      if (!siteId || seen[String(siteId)]) continue;
      seen[String(siteId)] = true;
      sites.push({
        id: siteId,
        text: est.getSublistText({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i })
      });
    }

    return sites;
  }

  function getKitComponents(kitItemId) {
    var kit = record.load({ type: record.Type.KIT_ITEM || 'kititem', id: kitItemId, isDynamic: false });
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

  function parseTaskJson(jsonText, stagingId) {
    if (!jsonText) throw new Error('Task JSON is blank on staging record ' + stagingId + '.');
    var parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [parsed];
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

  function makeBlockedError(opts) {
    opts = opts || {};
    return {
      key: opts.key || 'blocked:' + (opts.siteId || opts.lineRef || ''),
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

  function rollbackSiteProjectForErrors(estId, projectId, site, errors, opts) {
    var result = {
      deletedProjectId: '',
      deletedTaskIds: [],
      deletedSalesOrderIds: [],
      errors: [],
      warnings: []
    };

    if (!projectId || !(errors || []).length) return result;

    var siteMap = getErrorSiteMap(errors);
    if (!siteMap[String(site.id || '')]) return result;

    var rollback = rollbackGeneratedProject(estId, projectId, {
      siteAssetId: site.id,
      reason: opts && opts.reason ? opts.reason : 'Rollout site generation failed.'
    });

    return rollback;
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
      title: 'BC Rollout MR generation rollback started',
      details: JSON.stringify({
        estimateId: estId,
        projectId: projectId,
        siteAssetId: opts.siteAssetId || '',
        reason: opts.reason || ''
      })
    });

    var salesOrderIds = findGeneratedSalesOrderIdsForProject(estId, projectId, opts.siteAssetId);
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
      title: 'BC Rollout MR generation rollback completed',
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
      record.delete({ type: recordType, id: recordId });
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
        title: 'BC Rollout MR rollback delete failed',
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
        title: 'BC Rollout MR rollback Sales Order ownership check skipped',
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
      var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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
        title: 'BC Rollout MR rollback Estimate line Sales Order lookup skipped',
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
      var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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

      if (changed) est.save({ enableSourcing: true, ignoreMandatoryFields: true });
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

  function removeIds(ids, idsToRemove) {
    var removeMap = {};
    for (var i = 0; i < (idsToRemove || []).length; i++) removeMap[String(idsToRemove[i])] = true;

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

  function hasAnyCreated(parentProjectId, childProjectIds, taskIds, salesOrderIds) {
    return !!parentProjectId ||
      (childProjectIds && childProjectIds.length > 0) ||
      (taskIds && taskIds.length > 0) ||
      (salesOrderIds && salesOrderIds.length > 0);
  }

  function getEstimateIdFromContext(value) {
    try {
      var parsed = JSON.parse(value);
      return parsed.id || parsed.values.internalid.value || parsed.values.internalid;
    } catch (ignore) {
      return value;
    }
  }

  function setTaskField(projectTask, fieldId, value) {
    if (value === '' || value === null || value === undefined) return;
    projectTask.setValue({ fieldId: fieldId, value: normalizeTaskFieldValue(fieldId, value) });
  }

  function normalizeTaskFieldValue(fieldId, value) {
    if (fieldId === 'startdate') return parseDateValue(value);
    if (fieldId === 'starttime') return parseTimeValue(value);
    return value;
  }

  function parseDateValue(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') return value;
    try {
      return format.parse({ value: String(value), type: format.Type.DATE });
    } catch (e) {
      return new Date(value);
    }
  }

  function parseTimeValue(value) {
    try {
      return format.parse({ value: String(value), type: format.Type.TIMEOFDAY });
    } catch (e) {
      return value;
    }
  }

  function setCurrentTaskAssigneeField(projectTask, fieldId, value) {
    if (value === '' || value === null || value === undefined) return;
    projectTask.setCurrentSublistValue({ sublistId: TASK_ASSIGNEE.SUBLIST, fieldId: fieldId, value: value });
  }

  function setIfPresent(rec, fieldId, value) {
    if (value !== '' && value !== null && value !== undefined) rec.setValue({ fieldId: fieldId, value: value });
  }

  function setSublistIfPresent(rec, sublistId, fieldId, line, value) {
    if (value !== '' && value !== null && value !== undefined) {
      rec.setSublistValue({ sublistId: sublistId, fieldId: fieldId, line: line, value: value });
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
      return rec.getSublistValue({ sublistId: sublistId, fieldId: fieldId, line: line });
    } catch (e) {
      return '';
    }
  }

  function isKitItemType(itemType) {
    return String(itemType || '').toLowerCase().indexOf('kit') !== -1;
  }

  function parseStagingIds(value) {
    if (value === '' || value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.map(String);
    return String(value).match(/\d+/g) || [];
  }

  function objectValues(obj) {
    var values = [];
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) values.push(obj[key]);
    }
    return values;
  }

  function toNumber(value, defaultValue) {
    var n = Number(String(value === null || value === undefined ? '' : value).replace(/,/g, ''));
    return isNaN(n) ? defaultValue : n;
  }

  function roundCurrency(value) {
    return Math.round(toNumber(value, 0) * 100) / 100;
  }

  function isBlankValue(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }

  function makeProjectName(prefix, tranId) {
    return prefix + ' - Estimate ' + (tranId || '');
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

  return {
    getInputData: getInputData,
    map: map,
    reduce: reduce,
    summarize: summarize
  };
});
/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Background processor for National Rollout Estimate generation.
 *
 * Script ID: customscript_bc_mr_rollout_generation
 * On-demand deployment: customdeploy_bc_mr_rollout_gen_now
 * Scheduled deployment: customdeploy_bc_mr_rollout_gen_sched
 */
define(['N/record', 'N/search', 'N/log', 'N/format', 'N/runtime'], function (record, search, log, format, runtime) {

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
    ESTIMATE_TYPE: 'custbody_bc_estimate_type',
    PROJECT_GENERATED: 'custbody_bc_project_generated',
    GENERATED_PROJECT: 'custbody_bc_project',
    GENERATION_STATUS: 'custbody_bc_generation_status',
    ERROR_DETAILS: 'custbody_bc_error_details'
  };

  var EST_LINE = {
    SITE_ASSET: 'custcol_nx_asset',
    STAGING_IDS: 'custcol_nscpq_proj_task_staging_ids',
    RELATED_SALES_ORDER: 'custcol_bc_related_sales_order',
    TAX_CODE: 'taxcode'
  };

  var STAGING = {
    TYPE: 'customrecord_nscpq_task_staging',
    NAME: 'name',
    JSON: 'custrecord_task_json',
    TRANSACTION: 'custrecord_task_transaction',
    LINE_REF: 'custrecord_task_line_ref'
  };

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

  var PROJ = {
    NAME: 'companyname',
    CUSTOMER_PARENT: 'parent',
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
    SOURCE_ESTIMATE: 'custentity_bc_source_estimate'
  };

  var SO = {
    PROJECT: 'job',
    SOURCE_ESTIMATE: 'custbody_bc_source_estimate'
  };

  var GEN_STATUS = {
    PENDING: '1',
    PROCESSING: '2',
    COMPLETED: '3',
    FAILED: '4',
    PARTIAL_ERROR: '5',
    RETRY_PENDING: '6'
  };

  var ESTIMATE_TYPE_ROLLOUT = '2';
  var FIXED_FEE_PROJECT_TYPE = '18';
  var MR_PARAM_ESTIMATE_ID = 'custscript_bc_rollout_estimate_id';

  function getInputData() {
    var estId = runtime.getCurrentScript().getParameter({ name: MR_PARAM_ESTIMATE_ID });
    if (estId) return buildSiteInputsForEstimate(estId);

    var inputs = [];

    search.create({
      type: search.Type.ESTIMATE || 'estimate',
      filters: [
        ['mainline', 'is', 'T'],
        'AND',
        [EST.ESTIMATE_TYPE, 'anyof', ESTIMATE_TYPE_ROLLOUT],
        'AND',
        [EST.PROJECT_GENERATED, 'is', 'F'],
        'AND',
        [
          [EST.GENERATION_STATUS, 'anyof', GEN_STATUS.PENDING],
          'OR',
          [EST.GENERATION_STATUS, 'anyof', GEN_STATUS.RETRY_PENDING]
        ]
      ],
      columns: [search.createColumn({ name: 'internalid', sort: search.Sort.ASC })]
    }).run().each(function (result) {
      inputs = inputs.concat(buildSiteInputsForEstimate(result.getValue({ name: 'internalid' })));
      return true;
    });

    return inputs;
  }

  function map(context) {
    var input = parseMapInput(context.value);
    var estId = input.estimateId;

    try {
      if (input.recordType === 'estimate_error') {
        context.write({
          key: estId,
          value: JSON.stringify({
            success: false,
            estimateId: estId,
            parentProjectId: input.parentProjectId || '',
            errors: input.errors || [],
            warnings: []
          })
        });
        return;
      }

      if (input.recordType === 'estimate_finalize') {
        context.write({
          key: estId,
          value: JSON.stringify({
            success: true,
            estimateId: estId,
            parentProjectId: input.parentProjectId || '',
            errors: [],
            warnings: []
          })
        });
        return;
      }

      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });

      var result = processRolloutSite(est, input);
      context.write({ key: estId, value: JSON.stringify(result) });
    } catch (e) {
      context.write({
        key: estId,
        value: JSON.stringify({
          success: false,
          estimateId: estId,
          parentProjectId: input.parentProjectId || '',
          siteId: input.siteId || '',
          siteText: input.siteText || '',
          errors: [{
            key: 'mr:site:' + estId + ':' + (input.siteId || 'estimate'),
            type: 'Map/Reduce',
            label: input.siteId ? 'Site ' + (input.siteText || input.siteId) : 'Rollout Background Processing',
            siteId: input.siteId || '',
            siteText: input.siteText || '',
            message: e.message || String(e)
          }],
          warnings: []
        })
      });
      log.error({
        title: 'BC Rollout MR site failed',
        details: JSON.stringify({ input: input, error: getErrorDetails(e) })
      });
    }
  }

  function reduce(context) {
    var estId = context.key;
    var parentProjectId = '';
    var childProjectIds = [];
    var taskIds = [];
    var salesOrderIds = [];
    var errors = [];
    var warnings = [];

    for (var i = 0; i < context.values.length; i++) {
      var result = JSON.parse(context.values[i] || '{}');
      if (result.parentProjectId && !parentProjectId) parentProjectId = result.parentProjectId;
      if (result.childProjectId) childProjectIds.push(result.childProjectId);
      if (result.taskIds && result.taskIds.length) taskIds = taskIds.concat(result.taskIds);
      if (result.salesOrderIds && result.salesOrderIds.length) salesOrderIds = salesOrderIds.concat(result.salesOrderIds);
      if (result.errors && result.errors.length) errors = errors.concat(result.errors);
      if (result.warnings && result.warnings.length) warnings = warnings.concat(result.warnings);
    }

    if (!parentProjectId) {
      try {
        var est = record.load({
          type: record.Type.ESTIMATE,
          id: estId,
          isDynamic: false
        });
        parentProjectId = findExistingRolloutParentProject(est, estId);
      } catch (ignoreParentLookup) {}
    }

    if (!parentProjectId) {
      errors.push({
        key: 'project:rollout-parent',
        type: 'Project',
        label: 'Rollout Parent Project',
        message: 'Parent Project was not found after all site processing completed.'
      });
    }

    if (errors.length) {
      persistGenerationErrors(
        estId,
        errors,
        warnings,
        hasAnyCreated(parentProjectId, childProjectIds, taskIds, salesOrderIds) ? GEN_STATUS.PARTIAL_ERROR : GEN_STATUS.FAILED
      );
    } else {
      markEstimateGenerated(estId, parentProjectId);
    }

    context.write({
      key: estId,
      value: JSON.stringify({
        success: errors.length === 0,
        parentProjectId: parentProjectId,
        childProjectIds: childProjectIds,
        taskIds: taskIds,
        salesOrderIds: salesOrderIds,
        errorCount: errors.length
      })
    });
  }

  function summarize(summary) {
    summary.mapSummary.errors.iterator().each(function (key, value) {
      log.error({ title: 'BC Rollout MR map error ' + key, details: value });
      return true;
    });

    summary.reduceSummary.errors.iterator().each(function (key, value) {
      log.error({ title: 'BC Rollout MR reduce error ' + key, details: value });
      return true;
    });
  }

  function buildSiteInputsForEstimate(estId) {
    try {
      var est = record.load({
        type: record.Type.ESTIMATE,
        id: estId,
        isDynamic: false
      });

      setGenerationStatus(estId, GEN_STATUS.PROCESSING, { generated: false });

      var sites = getUniqueLineSites(est);
      if (!sites.length) {
        return [makeMapInput({
          recordType: 'estimate_error',
          estimateId: estId,
          errors: [{
            key: 'estimate:no-sites:' + estId,
            type: 'Rollout',
            label: 'Rollout Site Input',
            message: 'Rollout Estimate has no unique line-level Site Assets.'
          }]
        })];
      }

      var parentResult = ensureRolloutParentProject(est, estId);
      if (parentResult.errors.length) {
        return [makeMapInput({
          recordType: 'estimate_error',
          estimateId: estId,
          parentProjectId: parentResult.parentProjectId || '',
          errors: parentResult.errors
        })];
      }

      var inputs = [];
      var childProjectBySite = getExistingChildProjectsBySite(estId);
      for (var i = 0; i < sites.length; i++) {
        if (!siteNeedsProcessing(est, estId, sites[i], childProjectBySite[String(sites[i].id)])) continue;

        inputs.push(makeMapInput({
          recordType: 'site',
          estimateId: estId,
          parentProjectId: parentResult.parentProjectId,
          siteId: sites[i].id,
          siteText: sites[i].text || ''
        }));
      }

      if (!inputs.length) {
        inputs.push(makeMapInput({
          recordType: 'estimate_finalize',
          estimateId: estId,
          parentProjectId: parentResult.parentProjectId
        }));
      }

      return inputs;
    } catch (e) {
      return [makeMapInput({
        recordType: 'estimate_error',
        estimateId: estId,
        errors: [{
          key: 'estimate:input:' + estId,
          type: 'Map/Reduce Input',
          label: 'Build Site Inputs',
          message: e.message || String(e)
        }]
      })];
    }
  }

  function ensureRolloutParentProject(est, estId) {
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

    return {
      parentProjectId: parentProjectId,
      errors: errors
    };
  }

  function siteNeedsProcessing(est, estId, site, childProjectId) {
    if (!childProjectId) return true;

    var expectedTasks = getExpectedTaskCountForSite(est, estId, site.id);
    var createdTasks = getCreatedProjectTaskCountForProject(estId, childProjectId);
    if (createdTasks < expectedTasks) return true;

    if (!findExistingSalesOrderForProject(estId, childProjectId, site.id)) return true;

    return false;
  }

  function getExpectedTaskCountForSite(est, estId, siteId) {
    var stagingRecords = getTaskStagingRecordsForEstimate(est, estId, { siteId: siteId });
    var expected = 0;

    for (var i = 0; i < stagingRecords.records.length; i++) {
      try {
        expected += parseTaskJson(stagingRecords.records[i].json, stagingRecords.records[i].id).length;
      } catch (ignoreBadJson) {
        expected++;
      }
    }

    return expected;
  }

  function getCreatedProjectTaskCountForProject(estId, projectId) {
    return search.create({
      type: search.Type.PROJECT_TASK || 'projecttask',
      filters: [
        [TASK.SOURCE_ESTIMATE, 'anyof', estId],
        'AND',
        [TASK.PROJECT, 'anyof', projectId]
      ],
      columns: ['internalid']
    }).runPaged({ pageSize: 1 }).count;
  }

  function processRolloutSite(est, input) {
    var estId = input.estimateId;
    var site = {
      id: input.siteId,
      text: input.siteText || ''
    };

    if (!site.id) throw new Error('Missing Site Asset in Map/Reduce input.');

    var errors = [];
    var parentProjectId = input.parentProjectId || findExistingRolloutParentProject(est, estId);
    var childProjectBySite = getExistingChildProjectsBySite(estId);
    var childProjectId = childProjectBySite[String(site.id)];

    if (!parentProjectId) {
      errors.push({
        key: 'project:rollout-parent',
        type: 'Project',
        label: 'Rollout Parent Project',
        message: 'Parent Project was not found before processing Site ' + (site.text || site.id) + '.'
      });
    }

    if (parentProjectId && !childProjectId) {
      var childResult = tryCreateProject({
        estimate: est,
        estimateId: estId,
        parentId: parentProjectId,
        siteAssetId: site.id,
        siteText: site.text,
        namePrefix: 'Rollout Site ' + (site.text || site.id),
        attemptLabel: 'Rollout Child Project for Site ' + (site.text || site.id),
        errorKey: 'project:child:' + site.id
      });

      if (childResult.projectId) childProjectId = childResult.projectId;
      if (childResult.error) {
        errors.push(childResult.error);
        errors.push(makeBlockedError({
          key: 'blocked:task:site:' + site.id,
          type: 'Blocked Project Task',
          label: 'Project Tasks for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          message: 'Blocked because the child Project was not created.',
          blockedBy: childResult.error.key
        }));
        errors.push(makeBlockedError({
          key: 'blocked:so:site:' + site.id,
          type: 'Blocked Sales Order',
          label: 'Sales Order for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          message: 'Blocked because the child Project was not created.',
          blockedBy: childResult.error.key
        }));
      }
    }

    if (!childProjectId) {
      return {
        success: false,
        estimateId: estId,
        parentProjectId: parentProjectId,
        siteId: site.id,
        siteText: site.text,
        errors: errors,
        warnings: []
      };
    }

    var siteProjectMap = {};
    siteProjectMap[String(site.id)] = childProjectId;

    var taskResult = createProjectTasksForEstimate(est, estId, function () {
      return childProjectId;
    }, { siteId: site.id });

    var taskErrorSites = getErrorSiteMap(taskResult.errors);
    var taskRollback = rollbackSiteProjectForErrors(estId, childProjectId, site, taskResult.errors, {
      reason: 'Rollout Project Task generation failed.'
    });

    if (taskRollback.deletedProjectId) {
      childProjectId = '';
      delete siteProjectMap[String(site.id)];
      taskResult.taskIds = removeIds(taskResult.taskIds || [], taskRollback.deletedTaskIds);
    }

    var salesOrderResult = childProjectId ?
      createRolloutSalesOrdersFromEstimate(est, estId, [site], siteProjectMap, taskErrorSites) :
      { salesOrderIds: [], errors: [], estimateLinesUpdated: 0 };
    var salesOrderRollback = rollbackSiteProjectForErrors(estId, childProjectId, site, salesOrderResult.errors, {
      reason: 'Rollout Sales Order generation failed.'
    });

    if (salesOrderRollback.deletedProjectId) {
      childProjectId = '';
      taskResult.taskIds = removeIds(taskResult.taskIds || [], salesOrderRollback.deletedTaskIds);
      salesOrderResult.salesOrderIds = removeIds(salesOrderResult.salesOrderIds || [], salesOrderRollback.deletedSalesOrderIds);
    }

    var allErrors = errors
      .concat(taskResult.errors)
      .concat(taskRollback.errors)
      .concat(salesOrderResult.errors)
      .concat(salesOrderRollback.errors);

    return {
      success: allErrors.length === 0,
      estimateId: estId,
      parentProjectId: parentProjectId,
      childProjectId: childProjectId,
      siteId: site.id,
      siteText: site.text,
      taskIds: childProjectId ? taskResult.taskIds : [],
      salesOrderIds: salesOrderResult.salesOrderIds,
      errors: allErrors,
      warnings: (taskResult.warnings || []).concat(taskRollback.warnings).concat(salesOrderRollback.warnings)
    };
  }

  function parseMapInput(value) {
    if (!value) return {};
    try {
      return JSON.parse(value);
    } catch (e) {
      return {
        recordType: 'estimate_error',
        estimateId: getEstimateIdFromContext(value),
        errors: [{
          key: 'mr:input-parse:' + value,
          type: 'Map/Reduce Input',
          label: 'Parse Site Input',
          message: e.message || String(e)
        }]
      };
    }
  }

  function makeMapInput(input) {
    return JSON.stringify(input || {});
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
    project.setValue({ fieldId: PROJ.FS_CUSTOMER, value: est.getValue(EST.FSM_CUSTOMER) || est.getValue(EST.ENTITY) });

    return project.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  function tryCreateProject(opts) {
    try {
      return { projectId: createProject(opts), error: null };
    } catch (e) {
      var error = {
        key: opts.errorKey || 'project:' + (opts.siteAssetId || 'parent'),
        type: 'Project',
        label: opts.attemptLabel || opts.namePrefix || 'Project',
        siteId: opts.siteAssetId || '',
        siteText: opts.siteText || '',
        message: e.message || String(e)
      };
      log.error({ title: 'BC Rollout MR Project failed', details: JSON.stringify(error) });
      return { projectId: null, error: error };
    }
  }

  function createProjectTasksForEstimate(est, estId, resolveProjectId, opts) {
    opts = opts || {};
    var stagingRecords = getTaskStagingRecordsForEstimate(est, estId, opts);
    var taskIds = [];
    var errors = [];
    var warnings = stagingRecords.warnings || [];
    var expectedTaskCount = 0;
    var taskDateStateByProject = {};

    for (var s = 0; s < stagingRecords.records.length; s++) {
      var staging = stagingRecords.records[s];
      var taskRows = [];

      try {
        taskRows = parseTaskJson(staging.json, staging.id);
      } catch (jsonError) {
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
            continue;
          }

          taskIds.push(createProjectTask({
            estimate: est,
            estimateId: estId,
            projectId: projectId,
            staging: staging,
            taskData: taskData
          }));
        } catch (taskError) {
          errors.push(makeTaskError(staging, taskData, taskError.message || String(taskError)));
        }
      }
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
    var projectTask = record.create({ type: record.Type.PROJECT_TASK, isDynamic: true });

    projectTask.setValue({ fieldId: TASK.PROJECT, value: opts.projectId });
    projectTask.setValue({ fieldId: TASK.SOURCE_ESTIMATE, value: opts.estimateId });
    setProjectTaskExternalId(projectTask, opts);
    setTaskField(projectTask, TASK.TITLE, taskData.title);
    setTaskField(projectTask, 'status', taskData.status);
    setTaskField(projectTask, 'estimatedwork', taskData.estimatedwork);
    setTaskField(projectTask, 'constrainttype', taskData.constrainttype);
    setTaskField(projectTask, 'duration', taskData.duration);
    setTaskField(projectTask, 'plannedwork', taskData.plannedwork);
    setTaskField(projectTask, 'startdate', getProjectTaskStartDate(opts, taskData));
    setTaskField(projectTask, 'starttime', taskData.starttime);
    setTaskField(projectTask, 'custevent_nx_task_type', taskData.custevent_nx_task_type);
    setTaskField(projectTask, TASK.ASSET, taskData[TASK.ASSET] || opts.staging.siteAssetId || opts.estimate.getValue(EST.SITE_ASSET));
    addProjectTaskAssignee(projectTask, opts, taskData);

    return projectTask.save({ enableSourcing: true, ignoreMandatoryFields: true });
  }

  function addProjectTaskAssignee(projectTask, opts, taskData) {
    var resourceId = taskData.resource || taskData.assignee || taskData.projectresource || opts.estimate.getValue(EST.PROJECTMANAGER);
    if (!resourceId) throw new Error('No Project Task resource found. Populate Estimate Project Manager or pass resource in the CPQ task JSON.');

    projectTask.selectNewLine({ sublistId: TASK_ASSIGNEE.SUBLIST });
    projectTask.setCurrentSublistValue({ sublistId: TASK_ASSIGNEE.SUBLIST, fieldId: TASK_ASSIGNEE.RESOURCE, value: resourceId });
    setCurrentTaskAssigneeField(projectTask, TASK_ASSIGNEE.PLANNED_WORK, taskData.plannedwork || taskData.estimatedwork || taskData.duration || 0);
    setCurrentTaskAssigneeField(projectTask, TASK_ASSIGNEE.UNIT_COST, taskData.unitcost || taskData.cost || taskData.resourcecost || 0);
    projectTask.commitLine({ sublistId: TASK_ASSIGNEE.SUBLIST });
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
        errors.push({
          key: 'so:site:' + site.id,
          type: 'Sales Order',
          label: 'Sales Order for Site ' + (site.text || site.id),
          siteId: site.id,
          siteText: site.text,
          salesOrderId: e.salesOrderId || '',
          message: e.message || String(e)
        });
      }
    }

    return { salesOrderIds: salesOrderIds, errors: errors, estimateLinesUpdated: estimateLinesUpdated };
  }

  function createRolloutSalesOrderForSite(est, estId, site, projectId) {
    var existingSalesOrderId = findExistingSalesOrderForProject(estId, projectId, site.id);
    if (existingSalesOrderId) {
      return {
        salesOrderId: existingSalesOrderId,
        estimateLinesUpdated: updateEstimateLinesWithSalesOrder(estId, existingSalesOrderId, site.id),
        reused: true
      };
    }

    var lines = getSalesOrderLinesForSite(est, site.id);
    if (!lines.length) throw new Error('No Estimate item lines found for Site Asset ' + (site.text || site.id) + '.');

    var salesOrderId;
    var salesOrder = record.create({ type: record.Type.SALES_ORDER, isDynamic: false });

    try {
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
        salesOrder.setSublistValue({ sublistId: 'item', fieldId: 'item', line: i, value: lines[i].itemId });
        setSublistIfPresent(salesOrder, 'item', 'quantity', i, lines[i].quantity);
        setSublistIfPresent(salesOrder, 'item', 'department', i, lines[i].department);
        setSublistIfPresent(salesOrder, 'item', 'class', i, lines[i].classId);
        setSublistIfPresent(salesOrder, 'item', 'location', i, lines[i].location);
        setSublistIfPresent(salesOrder, 'item', EST_LINE.TAX_CODE, i, lines[i].taxCode);
        ensureSalesOrderLineAmount(salesOrder, i, lines[i]);
        salesOrder.setSublistValue({ sublistId: 'item', fieldId: SO.PROJECT, line: i, value: projectId });
      }

      salesOrderId = salesOrder.save({ enableSourcing: true, ignoreMandatoryFields: true });
      return {
        salesOrderId: salesOrderId,
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
      var lineDefaults = {
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
            department: lineDefaults.department,
            classId: lineDefaults.classId,
            location: lineDefaults.location,
            taxCode: lineDefaults.taxCode
          });
        }
      } else {
        lines.push({
          itemId: itemId,
          quantity: quantity,
          rate: sourceRate,
          amount: sourceAmount,
          department: lineDefaults.department,
          classId: lineDefaults.classId,
          location: lineDefaults.location,
          taxCode: lineDefaults.taxCode
        });
      }
    }

    return lines;
  }

  function getTaskStagingRecordsForEstimate(est, estId, opts) {
    var recordsById = {};
    var warnings = [];
    var lines = getEstimateLineTaskContexts(est);
    var ids = [];

    opts = opts || {};
    if (opts.siteId) {
      lines = filterLineContextsBySite(lines, opts.siteId);
    }

    for (var i = 0; i < lines.length; i++) {
      for (var idIndex = 0; idIndex < lines[i].stagingIds.length; idIndex++) {
        ids.push(lines[i].stagingIds[idIndex]);
      }
    }

    if (ids.length) addStagingRecordsByIds(recordsById, ids, lines);

    for (var l = 0; l < lines.length; l++) {
      if (lines[l].stagingIds.length) continue;

      var beforeCount = Object.keys(recordsById).length;
      addStagingRecordsByEstimateLine(recordsById, estId, lines[l]);
      if (beforeCount === Object.keys(recordsById).length) {
        warnings.push('No Project Task staging record found for Estimate line ' + lines[l].lineRef + ' (' + lines[l].itemText + ').');
      }
    }

    return { records: sortStagingRecords(objectValues(recordsById)), warnings: warnings };
  }

  function filterLineContextsBySite(lines, siteId) {
    var filtered = [];
    for (var i = 0; i < lines.length; i++) {
      if (String(lines[i].siteAssetId || '') === String(siteId || '')) {
        filtered.push(lines[i]);
      }
    }
    return filtered;
  }

  function getEstimateLineTaskContexts(est) {
    var lines = [];
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = 0; i < lineCount; i++) {
      var lineRef = est.getSublistValue({ sublistId: 'item', fieldId: 'line', line: i }) || (i + 1);
      lines.push({
        index: i,
        lineRef: String(lineRef),
        itemId: est.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i }),
        itemText: est.getSublistText({ sublistId: 'item', fieldId: 'item', line: i }) || '',
        siteAssetId: est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i }),
        siteText: est.getSublistText({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i }) || '',
        stagingIds: parseStagingIds(est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.STAGING_IDS, line: i }))
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
      recordsById[String(id)] = makeStagingRecordFromSearch(result, lineByStagingId[String(id)] || {});
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
      if (siteId && !bySite[String(siteId)]) bySite[String(siteId)] = result.getValue({ name: 'internalid' });
      return true;
    });
    return bySite;
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
      log.audit({ title: 'BC Rollout MR task external ID search skipped', details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) }) });
    }

    return found;
  }

  function setProjectTaskExternalId(projectTask, opts) {
    var externalId = makeProjectTaskExternalId(opts.estimateId, opts.projectId, opts.staging, opts.taskData);
    if (!externalId) return;

    try {
      projectTask.setValue({ fieldId: 'externalid', value: externalId });
    } catch (e) {
      log.audit({ title: 'BC Rollout MR task external ID skipped', details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) }) });
    }
  }

  function makeProjectTaskExternalId(estId, projectId, staging, taskData) {
    if (!estId || !projectId || !staging || !staging.id || !taskData || !taskData.__bcTaskIndex) return '';
    return sanitizeExternalId(['BC', 'EST', estId, 'PRJ', projectId, 'STG', staging.id, 'IDX', taskData.__bcTaskIndex].join('_'));
  }

  function sanitizeExternalId(value) {
    return String(value || '').replace(/[^A-Za-z0-9_:-]/g, '_').substring(0, 99);
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
        title: 'BC Rollout MR Sales Order external ID lookup skipped',
        details: JSON.stringify({ externalId: externalId, error: getErrorDetails(e) })
      });
    }

    return found;
  }

  function findLinkedSalesOrderFromEstimateLines(estId, projectId, siteAssetId) {
    try {
      var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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
        title: 'BC Rollout MR Sales Order Estimate line lookup skipped',
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
        title: 'BC Rollout MR Sales Order header link check skipped',
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
        title: 'BC Rollout MR Sales Order external ID skipped',
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
        title: 'BC Rollout MR Sales Order project lookup skipped',
        details: JSON.stringify({
          salesOrderId: salesOrderId,
          projectId: projectId,
          error: getErrorDetails(e)
        })
      });
      return false;
    }
  }

  function updateEstimateLinesWithSalesOrder(estId, salesOrderId, siteAssetId) {
    try {
      return updateEstimateLinesWithSalesOrderStatic(estId, salesOrderId, siteAssetId);
    } catch (staticError) {
      log.error({
        title: 'BC Rollout MR Estimate line Sales Order static link failed',
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
    var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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

    est.save({ enableSourcing: true, ignoreMandatoryFields: true });
    return updated;
  }

  function updateEstimateLinesWithSalesOrderDynamic(estId, salesOrderId, siteAssetId, originalError) {
    var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: true });
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;
    var updated = 0;
    var lineErrors = [];

    for (var i = 0; i < lineCount; i++) {
      if (!shouldAttachSalesOrderToEstimateLine(est, i, siteAssetId)) continue;

      try {
        est.selectLine({ sublistId: 'item', line: i });
        est.setCurrentSublistValue({
          sublistId: 'item',
          fieldId: EST_LINE.RELATED_SALES_ORDER,
          value: salesOrderId,
          ignoreFieldChange: true
        });
        est.commitLine({ sublistId: 'item' });
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

    est.save({ enableSourcing: true, ignoreMandatoryFields: true });
    return updated;
  }

  function shouldAttachSalesOrderToEstimateLine(est, line, siteAssetId) {
    var itemId = est.getSublistValue({ sublistId: 'item', fieldId: 'item', line: line });
    if (!itemId) return false;

    if (!siteAssetId) return true;

    var lineSiteAssetId = est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: line });
    return String(lineSiteAssetId || '') === String(siteAssetId || '');
  }

  function markEstimateGenerated(estId, projectId) {
    setGenerationStatus(estId, GEN_STATUS.COMPLETED, {
      projectId: projectId,
      generated: true,
      errorDetails: null
    });
  }

  function setGenerationStatus(estId, statusValue, opts) {
    var values = {};
    opts = opts || {};
    values[EST.GENERATION_STATUS] = statusValue;
    if (opts.projectId !== undefined && opts.projectId !== null && opts.projectId !== '') values[EST.GENERATED_PROJECT] = opts.projectId;
    if (opts.generated !== undefined) values[EST.PROJECT_GENERATED] = opts.generated === true;
    if (opts.errorDetails !== undefined) values[EST.ERROR_DETAILS] = opts.errorDetails ? JSON.stringify(opts.errorDetails) : '';

    record.submitFields({
      type: record.Type.ESTIMATE,
      id: estId,
      values: values,
      options: { enableSourcing: false, ignoreMandatoryFields: true }
    });
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

  function normalizeGenerationErrors(errors) {
    var normalized = [];
    var seen = {};
    for (var i = 0; i < (errors || []).length; i++) {
      var err = errors[i] || {};
      var key = err.key || [err.type || 'generation', err.siteId || err.lineRef || '', err.stagingId || '', err.taskIndex || '', i].join(':');
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
        salesOrderId: err.salesOrderId || '',
        blockedBy: err.blockedBy || '',
        retryable: err.retryable !== false,
        message: err.message || ''
      };
      normalized.push(seen[key]);
    }
    return normalized;
  }

  function getUniqueLineSites(est) {
    var seen = {};
    var sites = [];
    var lineCount = est.getLineCount({ sublistId: 'item' }) || 0;

    for (var i = 0; i < lineCount; i++) {
      var siteId = est.getSublistValue({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i });
      if (!siteId || seen[String(siteId)]) continue;
      seen[String(siteId)] = true;
      sites.push({
        id: siteId,
        text: est.getSublistText({ sublistId: 'item', fieldId: EST_LINE.SITE_ASSET, line: i })
      });
    }

    return sites;
  }

  function getKitComponents(kitItemId) {
    var kit = record.load({ type: record.Type.KIT_ITEM || 'kititem', id: kitItemId, isDynamic: false });
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

  function parseTaskJson(jsonText, stagingId) {
    if (!jsonText) throw new Error('Task JSON is blank on staging record ' + stagingId + '.');
    var parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [parsed];
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

  function makeBlockedError(opts) {
    opts = opts || {};
    return {
      key: opts.key || 'blocked:' + (opts.siteId || opts.lineRef || ''),
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

  function rollbackSiteProjectForErrors(estId, projectId, site, errors, opts) {
    var result = {
      deletedProjectId: '',
      deletedTaskIds: [],
      deletedSalesOrderIds: [],
      errors: [],
      warnings: []
    };

    if (!projectId || !(errors || []).length) return result;

    var siteMap = getErrorSiteMap(errors);
    if (!siteMap[String(site.id || '')]) return result;

    var rollback = rollbackGeneratedProject(estId, projectId, {
      siteAssetId: site.id,
      reason: opts && opts.reason ? opts.reason : 'Rollout site generation failed.'
    });

    return rollback;
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
      title: 'BC Rollout MR generation rollback started',
      details: JSON.stringify({
        estimateId: estId,
        projectId: projectId,
        siteAssetId: opts.siteAssetId || '',
        reason: opts.reason || ''
      })
    });

    var salesOrderIds = findGeneratedSalesOrderIdsForProject(estId, projectId, opts.siteAssetId);
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
      title: 'BC Rollout MR generation rollback completed',
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
      record.delete({ type: recordType, id: recordId });
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
        title: 'BC Rollout MR rollback delete failed',
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
        title: 'BC Rollout MR rollback Sales Order ownership check skipped',
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
      var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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
        title: 'BC Rollout MR rollback Estimate line Sales Order lookup skipped',
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
      var est = record.load({ type: record.Type.ESTIMATE, id: estId, isDynamic: false });
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

      if (changed) est.save({ enableSourcing: true, ignoreMandatoryFields: true });
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

  function removeIds(ids, idsToRemove) {
    var removeMap = {};
    for (var i = 0; i < (idsToRemove || []).length; i++) removeMap[String(idsToRemove[i])] = true;

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

  function hasAnyCreated(parentProjectId, childProjectIds, taskIds, salesOrderIds) {
    return !!parentProjectId ||
      (childProjectIds && childProjectIds.length > 0) ||
      (taskIds && taskIds.length > 0) ||
      (salesOrderIds && salesOrderIds.length > 0);
  }

  function getEstimateIdFromContext(value) {
    try {
      var parsed = JSON.parse(value);
      return parsed.id || parsed.values.internalid.value || parsed.values.internalid;
    } catch (ignore) {
      return value;
    }
  }

  function setTaskField(projectTask, fieldId, value) {
    if (value === '' || value === null || value === undefined) return;
    projectTask.setValue({ fieldId: fieldId, value: normalizeTaskFieldValue(fieldId, value) });
  }

  function normalizeTaskFieldValue(fieldId, value) {
    if (fieldId === 'startdate') return parseDateValue(value);
    if (fieldId === 'starttime') return parseTimeValue(value);
    return value;
  }

  function parseDateValue(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') return value;
    try {
      return format.parse({ value: String(value), type: format.Type.DATE });
    } catch (e) {
      return new Date(value);
    }
  }

  function parseTimeValue(value) {
    try {
      return format.parse({ value: String(value), type: format.Type.TIMEOFDAY });
    } catch (e) {
      return value;
    }
  }

  function setCurrentTaskAssigneeField(projectTask, fieldId, value) {
    if (value === '' || value === null || value === undefined) return;
    projectTask.setCurrentSublistValue({ sublistId: TASK_ASSIGNEE.SUBLIST, fieldId: fieldId, value: value });
  }

  function setIfPresent(rec, fieldId, value) {
    if (value !== '' && value !== null && value !== undefined) rec.setValue({ fieldId: fieldId, value: value });
  }

  function setSublistIfPresent(rec, sublistId, fieldId, line, value) {
    if (value !== '' && value !== null && value !== undefined) {
      rec.setSublistValue({ sublistId: sublistId, fieldId: fieldId, line: line, value: value });
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
      return rec.getSublistValue({ sublistId: sublistId, fieldId: fieldId, line: line });
    } catch (e) {
      return '';
    }
  }

  function isKitItemType(itemType) {
    return String(itemType || '').toLowerCase().indexOf('kit') !== -1;
  }

  function parseStagingIds(value) {
    if (value === '' || value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.map(String);
    return String(value).match(/\d+/g) || [];
  }

  function objectValues(obj) {
    var values = [];
    for (var key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) values.push(obj[key]);
    }
    return values;
  }

  function toNumber(value, defaultValue) {
    var n = Number(String(value === null || value === undefined ? '' : value).replace(/,/g, ''));
    return isNaN(n) ? defaultValue : n;
  }

  function roundCurrency(value) {
    return Math.round(toNumber(value, 0) * 100) / 100;
  }

  function isBlankValue(value) {
    return value === null || value === undefined || String(value).trim() === '';
  }

  function makeProjectName(prefix, tranId) {
    return prefix + ' - Estimate ' + (tranId || '');
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

  return {
    getInputData: getInputData,
    map: map,
    reduce: reduce,
    summarize: summarize
  };
});
