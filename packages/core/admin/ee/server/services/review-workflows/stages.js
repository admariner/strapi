'use strict';

const {
  mapAsync,
  errors: { ApplicationError },
} = require('@strapi/utils');

const { STAGE_MODEL_UID, ENTITY_STAGE_ATTRIBUTE } = require('../../constants/workflows');
const { getService } = require('../../utils');
const { getDefaultWorkflow } = require('../../utils/review-workflows');

module.exports = ({ strapi }) => {
  const workflowsService = getService('workflows', { strapi });

  return {
    find({ workflowId, populate }) {
      const params = {
        filters: { workflow: workflowId },
        populate,
      };
      return strapi.entityService.findMany(STAGE_MODEL_UID, params);
    },

    findById(id, { workflowId, populate }) {
      const params = {
        filters: { workflow: workflowId },
        populate,
      };
      return strapi.entityService.findOne(STAGE_MODEL_UID, id, params);
    },

    createMany(stagesList, { fields }) {
      const params = {
        select: fields,
      };
      return Promise.all(
        stagesList.map((stage) =>
          strapi.entityService.create(STAGE_MODEL_UID, { data: stage, ...params })
        )
      );
    },

    update(stageId, stageData) {
      return strapi.entityService.update(STAGE_MODEL_UID, stageId, { data: stageData });
    },

    delete(stageId) {
      return strapi.entityService.delete(STAGE_MODEL_UID, stageId);
    },

    count() {
      return strapi.entityService.count(STAGE_MODEL_UID);
    },

    async replaceWorkflowStages(workflowId, stages) {
      const workflow = await workflowsService.findById(workflowId, { populate: ['stages'] });

      const { created, updated, deleted } = getDiffBetweenStages(workflow.stages, stages);

      assertAtLeastOneStageRemain(workflow.stages, { created, deleted });

      return strapi.db.transaction(async () => {
        const newStages = await this.createMany(created, { fields: ['id'] });
        const stagesIds = stages.map((stage) => stage.id ?? newStages.shift().id);
        const defaultWorkflow = await getDefaultWorkflow({ strapi });

        await mapAsync(updated, (stage) => this.update(stage.id, stage));

        const entitiesToMove = [];
        await mapAsync(deleted, async (stage) => {
          // Find any entities related to this stage
          const stageInfo = await this.findById(stage.id, {
            workflowId: defaultWorkflow.id,
            populate: ['related'],
          });

          if (!stageInfo?.related?.length) {
            // If there are no related entities, just delete the stage
            return this.delete(stage.id);
          }

          // This stage has related entities that need to be moved to their
          // target stage
          // Find the nearest stage in the workflow that is not deleted,
          // prioritizing the previous stages
          const targetStageId = findNearestMatchingStageID(
            defaultWorkflow.stages,
            defaultWorkflow.stages.findIndex((s) => s.id === stage.id),
            (targetStage) => {
              return !deleted.find((s) => s.id === targetStage.id);
            }
          );

          // Keep track of the entities to move and their target stages
          entitiesToMove.push(...stageInfo.related.map((entity) => ({ ...entity, targetStageId })));

          return this.delete(stage.id);
        });

        // Move all the entities whose stage was deleted to their target stage
        await mapAsync(entitiesToMove, (entity) => {
          return this.updateEntity(
            {
              id: entity.id,
              modelUID: entity.__type,
            },
            entity.targetStageId
          );
        });

        return workflowsService.update(workflowId, {
          stages: stagesIds,
        });
      });
    },

    /**
     * Update the stage of an entity
     *
     * @param {object} entityInfo
     * @param {number} entityInfo.id - Entity id
     * @param {string} entityInfo.modelUID - the content-type of the entity
     * @param {number} stageId - The id of the stage to assign to the entity
     */
    updateEntity(entityInfo, stageId) {
      return strapi.entityService.update(entityInfo.modelUID, entityInfo.id, {
        data: { [ENTITY_STAGE_ATTRIBUTE]: stageId },
        populate: [ENTITY_STAGE_ATTRIBUTE],
      });
    },
  };
};

/**
 * Compares two arrays of stages and returns an object indicating the differences.
 *
 * The function compares the `id` properties of each stage in `sourceStages` and `comparisonStages` to determine if the stage is present in both arrays.
 * If a stage with the same `id` is found in both arrays but the `name` property is different, the stage is considered updated.
 * If a stage with a particular `id` is only found in `comparisonStages`, it is considered created.
 * If a stage with a particular `id` is only found in `sourceStages`, it is considered deleted.
 *
 * @typedef {{id: Number, name: String, workflow: Number}} Stage
 * @typedef {{created: Stage[], updated: Stage[], deleted: Stage[]}} DiffStages
 *
 * The DiffStages object has three properties: `created`, `updated`, and `deleted`.
 * `created` is an array of stages that are in `comparisonStages` but not in `sourceStages`.
 * `updated` is an array of stages that have different names in `comparisonStages` and `sourceStages`.
 * `deleted` is an array of stages that are in `sourceStages` but not in `comparisonStages`.
 *
 * @param {Stage[]} sourceStages
 * @param {Stage[]} comparisonStages
 * @returns { DiffStages }
 */
function getDiffBetweenStages(sourceStages, comparisonStages) {
  const result = comparisonStages.reduce(
    (acc, stageToCompare) => {
      const srcStage = sourceStages.find((stage) => stage.id === stageToCompare.id);

      if (!srcStage) {
        acc.created.push(stageToCompare);
      } else if (srcStage.name !== stageToCompare.name) {
        acc.updated.push(stageToCompare);
      }
      return acc;
    },
    { created: [], updated: [] }
  );

  result.deleted = sourceStages.filter(
    (srcStage) => !comparisonStages.some((cmpStage) => cmpStage.id === srcStage.id)
  );

  return result;
}

/**
 * Asserts that at least one stage remains in the workflow after applying deletions and additions.
 *
 * @param {Array} workflowStages - An array of stages in the current workflow.
 * @param {Object} diffStages - An object containing the stages to be deleted and created.
 * @param {Array} diffStages.deleted - An array of stages that are planned to be deleted from the workflow.
 * @param {Array} diffStages.created - An array of stages that are planned to be created in the workflow.
 *
 * @throws {ApplicationError} If the number of remaining stages in the workflow after applying deletions and additions is less than 1.
 */
function assertAtLeastOneStageRemain(workflowStages, diffStages) {
  const remainingStagesCount =
    workflowStages.length - diffStages.deleted.length + diffStages.created.length;
  if (remainingStagesCount < 1) {
    throw new ApplicationError('At least one stage must remain in the workflow.');
  }
}

/**
 * Find the id of the nearest object in an array that matches a condition.
 * Used for searching for the nearest stage that is not deleted.
 * Starts by searching the elements before the index, then the remaining elements in the array.
 *
 * @param {Array} stages of stages
 * @param {Number} startIndex the index to start searching from
 * @param {Function} condition must evaluate to true for the object to be considered a match
 * @returns {Number}
 */
function findNearestMatchingStageID(stages, startIndex, condition) {
  // Start by searching the elements before the startIndex
  for (let i = startIndex; i >= 0; i -= 1) {
    if (condition(stages[i])) {
      return stages[i].id;
    }
  }

  // If no matching element is found before the startIndex,
  // search the remaining elements in the array
  const remainingArray = stages.slice(startIndex + 1);
  const nearestObject = remainingArray.filter(condition)[0];
  return nearestObject.id;
}
