/**
 * 🔬 Validation Strategies
 *
 * Exporta todas as estratégias de validação programática.
 */

export {
    CommandValidationStrategy,
    createTestValidationStrategy,
    createTypeCheckValidationStrategy,
    createLintValidationStrategy,
    createCustomValidationStrategy,
} from "./CommandValidationStrategy.js";

export {
    TestValidationStrategy,
    createBunTestStrategy,
    createPatternTestStrategy,
    createCoverageTestStrategy,
    createCustomTestStrategy,
} from "./TestValidationStrategy.js";

export {
    QualityGateRegistry,
    createQualityGateRegistry,
    createCustomQualityGateRegistry,
    createMinimalQualityGateRegistry,
} from "./QualityGateRegistry.js";

export type {
    QualityGateConfig,
    QualityGateResult,
    QualityGatesReport,
} from "./QualityGateRegistry.js";
