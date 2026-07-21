"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRepositoryProcessingKey = validateRepositoryProcessingKey;
const REPOSITORY_KEY = /^repositories\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[^/]+$/i;
const LEGACY_USER_KEY = /^\d+\/\d+-[\w.-]+$/;
function validateRepositoryProcessingKey(key) {
    if (key.includes("../") || key.includes("..\\") || key.startsWith("/")) {
        return false;
    }
    return REPOSITORY_KEY.test(key) || LEGACY_USER_KEY.test(key);
}
