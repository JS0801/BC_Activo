/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], (record, log) => {
    const TASK_STAGING_RECORD = 'customrecord_nscpq_task_staging';

    const FIELD_TRANSACTION = 'custrecord_task_transaction';
    const FIELD_LINE_REF = 'custrecord_task_line_ref';

    const SO_LINE_STAGING_IDS = 'custcol_nscpq_proj_task_staging_ids';

    function afterSubmit(context) {
        try {
            if (context.type === context.UserEventType.DELETE) {
                return;
            }

            const salesOrder = context.newRecord;
            const salesOrderId = salesOrder.id;

            const lineCount = salesOrder.getLineCount({
                sublistId: 'item',
            });

            for (let i = 0; i < lineCount; i++) {
                const stagingIdsValue = salesOrder.getSublistValue({
                    sublistId: 'item',
                    fieldId: SO_LINE_STAGING_IDS,
                    line: i,
                });

                if (!stagingIdsValue) {
                    continue;
                }

                const lineRef = i + 1;

                const stagingIds = String(stagingIdsValue)
                    .split(',')
                    .map((id) => id.trim())
                    .filter((id) => id);

                for (const stagingId of stagingIds) {
                    try {
                        record.submitFields({
                            type: TASK_STAGING_RECORD,
                            id: stagingId,
                            values: {
                                [FIELD_TRANSACTION]: salesOrderId,
                                [FIELD_LINE_REF]: lineRef,
                            },
                            options: {
                                enableSourcing: false,
                                ignoreMandatoryFields: true,
                            },
                        });

                        log.debug({
                            title: 'Updated task staging record',
                            details: {
                                stagingId,
                                salesOrderId,
                                lineRef,
                            },
                        });
                    } catch (lineError) {
                        log.error({
                            title: 'Failed to update task staging record',
                            details: {
                                stagingId,
                                salesOrderId,
                                lineRef,
                                error: lineError,
                            },
                        });
                    }
                }
            }
        } catch (error) {
            log.error({
                title: 'Error in Sales Order afterSubmit',
                details: error,
            });
        }
    }

    return {
        afterSubmit,
    };
});
