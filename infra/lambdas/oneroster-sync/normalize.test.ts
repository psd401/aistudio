import { describe, expect, it } from "bun:test";
import {
  normalizeClass,
  normalizeEnrollment,
  normalizeStatus,
  normalizeUser,
} from "./normalize";
import { parseCredentials } from "./config";

describe("OneRoster normalization", () => {
  it("normalizes deletion markers and the cross-system email join key", () => {
    const normalized = normalizeUser({
      sourcedId: "user-1",
      status: "to-be-deleted",
      email: " STUDENT@Example.COM ",
      username: "student",
      givenName: "New",
      familyName: "Name",
      enabledUser: "false",
      grades: ["10"],
      roles: [
        {
          role: "student",
          roleType: "primary",
          org: { sourcedId: "school-1" },
        },
      ],
      demographics: { birthDate: "2000-01-01" },
    });

    expect(normalizeStatus("TO_BE_DELETED")).toBe("tobedeleted");
    expect(normalized.entity).toMatchObject({
      sourced_id: "user-1",
      email: "student@example.com",
      given_name: "New",
      family_name: "Name",
      enabled_user: false,
      is_active: false,
    });
    expect(normalized.entity).not.toHaveProperty("demographics");
    expect(normalized.roles).toEqual([
      expect.objectContaining({
        user_sourced_id: "user-1",
        role: "student",
        org_sourced_id: "school-1",
        is_active: false,
      }),
    ]);
  });

  it("maps changed class and enrollment fields into persisted column names", () => {
    const normalizedClass = normalizeClass({
      sourcedId: "class-1",
      title: "Changed title",
      classCode: "ALG-2",
      classType: "scheduled",
      location: "Room 4",
      course: { sourcedId: "course-1" },
      school: { sourcedId: "school-1" },
      terms: [{ sourcedId: "term-1" }, { sourcedId: "term-1" }],
      subjects: ["Mathematics"],
      periods: ["2"],
    });
    const enrollment = normalizeEnrollment({
      sourcedId: "enrollment-1",
      user: { sourcedId: "user-1" },
      class: { sourcedId: "class-1" },
      school: { sourcedId: "school-1" },
      role: "student",
      primary: true,
      beginDate: "2026-08-01",
    });

    expect(normalizedClass.entity).toMatchObject({
      title: "Changed title",
      class_code: "ALG-2",
      location: "Room 4",
      course_sourced_id: "course-1",
    });
    expect(normalizedClass.terms).toHaveLength(1);
    expect(enrollment).toMatchObject({
      user_sourced_id: "user-1",
      class_sourced_id: "class-1",
      is_primary: true,
      begin_date: "2026-08-01",
    });
  });
});

describe("ClassLink credential parsing", () => {
  it("accepts only direct OAuth1 or static proxy bearer shapes", () => {
    expect(
      parseCredentials(
        JSON.stringify({ consumerKey: "key", consumerSecret: "secret" }),
        "oauth1"
      )
    ).toEqual({
      mode: "oauth1",
      consumerKey: "key",
      consumerSecret: "secret",
    });
    expect(
      parseCredentials(JSON.stringify({ bearerToken: "token" }), "proxy")
    ).toEqual({ mode: "proxy", bearerToken: "token" });
    expect(() =>
      parseCredentials(
        JSON.stringify({
          clientId: "id",
          clientSecret: "secret",
          tokenUrl: "https://example/token",
        }),
        "proxy"
      )
    ).toThrow("bearerToken");
    expect(() => parseCredentials("null", "oauth1")).toThrow("JSON object");
  });
});
