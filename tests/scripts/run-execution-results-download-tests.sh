#!/bin/bash

# Test runner script for Execution Results Download API tests
# This script runs all tests related to the execution results download functionality

set -e  # Exit on any error

echo "🚀 Running Execution Results Download API Tests"
echo "=============================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    print_error "Please run this script from the project root directory"
    exit 1
fi

# Check if Jest is available
if ! bun pm ls 2>/dev/null | grep -q jest; then
    print_error "Jest is not installed. Please run 'bun install' first."
    exit 1
fi

print_status "Starting execution results download API tests..."

# Test categories to run
UNIT_TESTS=(
    "tests/api/execution-results/\\[id\\]/download.test.ts"
    "tests/unit/execution-results-download-utils.test.ts"
    "tests/unit/execution-results-download-rate-limit.test.ts"
)

INTEGRATION_TESTS=(
    "tests/integration/execution-results-download.test.ts"
)

# Function to run test category
run_test_category() {
    local category_name="$1"
    local test_files=("${@:2}")

    print_status "Running ${category_name} tests..."

    for test_file in "${test_files[@]}"; do
        if [ -f "$test_file" ]; then
            print_status "  • Running $test_file"

            if bunx jest "$test_file" --verbose; then
                print_success "    ✅ $test_file passed"
            else
                print_error "    ❌ $test_file failed"
                return 1
            fi
        else
            print_warning "    ⚠️  Test file not found: $test_file"
        fi
    done

    print_success "${category_name} tests completed successfully!"
    return 0
}

# Function to run tests with coverage
run_with_coverage() {
    print_status "Running tests with coverage report..."

    # Run all execution results download tests with coverage
    bunx jest \
        --coverage \
        --collectCoverageFrom="app/api/execution-results/[id]/download/**/*.{ts,tsx}" \
        --coverageDirectory="coverage/execution-results-download" \
        --coverageReporters="text" \
        --coverageReporters="html" \
        --coverageReporters="lcov" \
        "tests/**/execution-results*download*.test.ts"
}

# Function to run specific test types
run_specific_tests() {
    local test_type="$1"

    case $test_type in
        "unit")
            print_status "Running unit tests only..."
            run_test_category "Unit" "${UNIT_TESTS[@]}"
            ;;
        "integration")
            print_status "Running integration tests only..."
            run_test_category "Integration" "${INTEGRATION_TESTS[@]}"
            ;;
        "coverage")
            run_with_coverage
            ;;
        *)
            print_error "Unknown test type: $test_type"
            print_error "Available types: unit, integration, coverage"
            exit 1
            ;;
    esac
}

# Function to run all tests
run_all_tests() {
    print_status "Running all execution results download tests..."

    # Run unit tests
    if ! run_test_category "Unit" "${UNIT_TESTS[@]}"; then
        print_error "Unit tests failed!"
        return 1
    fi

    echo ""

    # Run integration tests
    if ! run_test_category "Integration" "${INTEGRATION_TESTS[@]}"; then
        print_error "Integration tests failed!"
        return 1
    fi

    print_success "🎉 All execution results download tests passed!"
    return 0
}

# Function to validate test setup
validate_test_setup() {
    print_status "Validating test setup..."

    # Check for required test files
    local required_files=(
        "tests/utils/execution-result-test-data.ts"
        "jest.config.js"
        "tests/setup.ts"
    )

    for file in "${required_files[@]}"; do
        if [ ! -f "$file" ]; then
            print_warning "Test setup file missing: $file"
        fi
    done

    # Check if test utilities can be imported
    if bun -e "import './tests/utils/execution-result-test-data.ts'" 2>/dev/null; then
        print_success "Test utilities are properly configured"
    else
        print_warning "Test utilities may have import issues"
    fi
}

# Function to show test coverage summary
show_coverage_summary() {
    if [ -f "coverage/execution-results-download/lcov-report/index.html" ]; then
        print_success "Coverage report generated at: coverage/execution-results-download/lcov-report/index.html"

        if command -v open >/dev/null 2>&1; then
            print_status "Opening coverage report in browser..."
            open "coverage/execution-results-download/lcov-report/index.html"
        fi
    fi
}

# Function to run linting on test files
lint_test_files() {
    print_status "Linting test files..."

    local test_files=(
        "tests/api/execution-results/"
        "tests/integration/execution-results-download.test.ts"
        "tests/unit/execution-results-download-*.test.ts"
        "tests/utils/execution-result-test-data.ts"
    )

    for pattern in "${test_files[@]}"; do
        if ls $pattern 1> /dev/null 2>&1; then
            bunx eslint $pattern --ext .ts,.tsx
        fi
    done

    print_success "Linting completed"
}

# Function to type-check test files
typecheck_test_files() {
    print_status "Type-checking test files..."

    if bunx tsc --noEmit --project tsconfig.json; then
        print_success "Type checking passed"
    else
        print_error "Type checking failed"
        return 1
    fi
}

# Main execution
main() {
    local command="${1:-all}"

    case $command in
        "validate")
            validate_test_setup
            ;;
        "lint")
            lint_test_files
            ;;
        "typecheck")
            typecheck_test_files
            ;;
        "unit"|"integration"|"coverage")
            run_specific_tests "$command"
            ;;
        "all")
            validate_test_setup
            echo ""
            run_all_tests
            ;;
        "full")
            print_status "Running full test suite with validation..."
            validate_test_setup
            echo ""
            lint_test_files
            echo ""
            typecheck_test_files
            echo ""
            run_all_tests
            echo ""
            run_with_coverage
            show_coverage_summary
            ;;
        "help"|"-h"|"--help")
            echo "Usage: $0 [command]"
            echo ""
            echo "Commands:"
            echo "  all         Run all tests (default)"
            echo "  unit        Run unit tests only"
            echo "  integration Run integration tests only"
            echo "  coverage    Run tests with coverage report"
            echo "  validate    Validate test setup"
            echo "  lint        Lint test files"
            echo "  typecheck   Type-check test files"
            echo "  full        Run complete test suite with validation"
            echo "  help        Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                  # Run all tests"
            echo "  $0 unit            # Run unit tests only"
            echo "  $0 coverage        # Run with coverage"
            echo "  $0 full           # Complete test suite"
            exit 0
            ;;
        *)
            print_error "Unknown command: $command"
            print_error "Use '$0 help' to see available commands"
            exit 1
            ;;
    esac
}

# Run main function with all arguments
main "$@"