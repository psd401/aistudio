"use server"

import { getCurrentUserAction } from "@/actions/db/get-current-user-action";
import { redirect } from "next/navigation";

/**
 * Server helper that requires certain role(s).
 * Throws an error or redirects if the current user lacks the required role(s).
 */
export async function requireRole(requiredRoles: string | string[]) {
  const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
  const result = await getCurrentUserAction();
  
  if (!result.isSuccess || !result.data) {
    redirect("/");
  }

  const userRoles = result.data.roles.map(r => r.name);
  const hasRole = roles.some(role => userRoles.includes(role));
  
  if (!hasRole) {
    redirect("/dashboard");
  }
  
  return result.data;
}

/**
 * Check if user has any of the required roles
 */
export async function hasRole(requiredRoles: string | string[]): Promise<boolean> {
  const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];
  const result = await getCurrentUserAction();
  
  if (!result.isSuccess || !result.data) {
    return false;
  }

  const userRoles = result.data.roles.map(r => r.name);
  return roles.some(role => userRoles.includes(role));
} 