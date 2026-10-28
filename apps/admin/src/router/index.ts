import { createRouter, createWebHistory } from 'vue-router';
import { NAV } from '../nav.ts';
import { useAuth } from '../stores/auth.ts';
import { decide } from './guard.ts';

const views: Record<string, () => Promise<unknown>> = {
  overview: () => import('../views/OverviewView.vue'),
  teachers: () => import('../views/TeachersView.vue'),
  orders: () => import('../views/OrdersView.vue'),
  settlements: () => import('../views/SettlementsView.vue'),
  audit: () => import('../views/AuditView.vue'),
  admins: () => import('../views/AdminsView.vue'),
};

export const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    { path: '/login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/403', component: () => import('../views/ForbiddenView.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('../layouts/MainLayout.vue'),
      redirect: '/overview',
      children: NAV.map((n) => ({
        name: n.name,
        path: n.path,
        component: views[n.name] as () => Promise<never>,
        meta: { roles: n.roles, title: n.title },
      })),
    },
    { path: '/:pathMatch(.*)*', redirect: '/overview' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.loaded) await auth.load();
  const d = decide(
    {
      path: to.path,
      fullPath: to.fullPath,
      roles: to.meta.roles as never,
      public: Boolean(to.meta.public),
    },
    auth.role,
  );
  return d === true ? true : d;
});
