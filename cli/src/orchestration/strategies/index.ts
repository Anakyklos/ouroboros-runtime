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
    QualityGateConfig,
    QualityGateResult,
    QualityGatesReport,
    createQualityGateRegistry,
    createCustomQualityGateRegistry,
    createMinimalQualityGateRegistry,
} from "./QualityGateRegistry.js";
