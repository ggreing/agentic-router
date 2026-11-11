import type { NewProjectInput, ProjectPatch } from '../models/project.ts';
import type { ProjectService } from '../service/projectService.ts';
import { bodyRecord, handle, ok, requireParam } from './http.ts';

export function createProjectHandlers(service: ProjectService) {
  return {
    /** POST /projects  body: { name, description? } */
    createProject: handle((req) => ok(service.createProject(req.userId, req.body as NewProjectInput), 201)),

    /** GET /projects/:id */
    getProject: handle((req) => ok(service.getProject(req.userId, requireParam(req, 'id')))),

    /** GET /projects?includeArchived=true */
    listProjects: handle((req) => ok({
      items: service.listProjects(req.userId, { includeArchived: req.query?.includeArchived === 'true' }),
    })),

    /** PATCH /projects/:id  body: { name?, description? } */
    updateProject: handle((req) => ok(service.updateProject(req.userId, requireParam(req, 'id'), req.body as ProjectPatch))),

    /** POST /projects/:id/archive */
    archiveProject: handle((req) => ok(service.archiveProject(req.userId, requireParam(req, 'id')))),

    /** POST /projects/:id/unarchive */
    unarchiveProject: handle((req) => ok(service.unarchiveProject(req.userId, requireParam(req, 'id')))),

    /** GET /projects/:id/members */
    listMembers: handle((req) => ok({ items: service.listMembers(req.userId, requireParam(req, 'id')) })),

    /** POST /projects/:id/members  body: { userId, role } */
    addMember: handle((req) => {
      const { userId, role } = bodyRecord(req);
      return ok(service.addMember(req.userId, requireParam(req, 'id'), userId, role), 201);
    }),

    /** PUT /projects/:id/members/:userId  body: { role } */
    changeMemberRole: handle((req) => {
      const { role } = bodyRecord(req);
      return ok(service.changeMemberRole(req.userId, requireParam(req, 'id'), requireParam(req, 'userId'), role));
    }),

    /** DELETE /projects/:id/members/:userId */
    removeMember: handle((req) => ok({
      unassignedTaskIds: service.removeMember(req.userId, requireParam(req, 'id'), requireParam(req, 'userId')),
    })),
  };
}

export type ProjectHandlers = ReturnType<typeof createProjectHandlers>;
