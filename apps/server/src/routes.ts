import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Deps } from './deps.ts';
import { adminAuthRoutes } from './modules/admin/routes.ts';
import { appointmentRoutes, teacherAppointmentRoutes } from './modules/appointments/routes.ts';
import { authRoutes } from './modules/auth/routes.ts';
import { imRoutes } from './modules/im/routes.ts';
import { leaveChoiceRoutes, substituteInviteRoutes, teacherLeaveRoutes } from './modules/leaves/routes.ts';
import { notificationRoutes } from './modules/notifications/routes.ts';
import { adminOrderRoutes } from './modules/orders/admin-routes.ts';
import { orderRoutes } from './modules/orders/routes.ts';
import { teacherPackageRoutes } from './modules/packages/routes.ts';
import { payRoutes } from './modules/pay/routes.ts';
import { relationRoutes, teacherStudentRoutes } from './modules/relations/routes.ts';
import { teacherScheduleRoutes } from './modules/schedule/routes.ts';
import { adminSettlementRoutes } from './modules/settlement/admin-routes.ts';
import { adminTeacherRoutes } from './modules/teachers/admin-routes.ts';
import { publicTeacherRoutes } from './modules/teachers/public-routes.ts';
import { teacherRoutes } from './modules/teachers/routes.ts';
import { trtcRoutes } from './modules/trtc/routes.ts';

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export async function registerRoutes(app: App, deps: Deps): Promise<void> {
  await app.register(authRoutes(deps), { prefix: '/api/auth' });
  await app.register(adminAuthRoutes(deps), { prefix: '/api/admin' });
  await app.register(teacherRoutes(deps), { prefix: '/api/teacher' });
  await app.register(teacherScheduleRoutes(deps), { prefix: '/api/teacher/schedule' });
  await app.register(appointmentRoutes(deps), { prefix: '/api/appointments' });
  await app.register(teacherAppointmentRoutes(deps), { prefix: '/api/teacher/appointments' });
  await app.register(teacherLeaveRoutes(deps), { prefix: '/api/teacher/leaves' });
  await app.register(substituteInviteRoutes(deps), { prefix: '/api/teacher/substitute-invites' });
  await app.register(leaveChoiceRoutes(deps), { prefix: '/api/leave-choices' });
  await app.register(imRoutes(deps), { prefix: '/api/im' });
  await app.register(trtcRoutes(deps), { prefix: '/api/trtc' });
  await app.register(teacherPackageRoutes(deps), { prefix: '/api/teacher/packages' });
  await app.register(adminTeacherRoutes(deps), { prefix: '/api/admin/teachers' });
  await app.register(publicTeacherRoutes(deps), { prefix: '/api/teachers' });
  await app.register(orderRoutes(deps), { prefix: '/api/orders' });
  await app.register(adminOrderRoutes(deps), { prefix: '/api/admin' });
  await app.register(payRoutes(deps), { prefix: '/api/pay' });
  await app.register(relationRoutes(deps), { prefix: '/api/relations' });
  await app.register(notificationRoutes(deps), { prefix: '/api/notifications' });
  await app.register(teacherStudentRoutes(deps), { prefix: '/api/teacher/students' });
  await app.register(adminSettlementRoutes(deps), { prefix: '/api/admin' });
}
