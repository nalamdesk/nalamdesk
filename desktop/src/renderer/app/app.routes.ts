import { Routes } from '@angular/router';
import { LoginComponent } from './login/login.component';
import { DashboardComponent } from './dashboard/dashboard.component';

import { authGuard } from './guards/auth.guard';
import { adminGuard } from './guards/admin.guard';

export const routes: Routes = [
    { path: '', redirectTo: 'login', pathMatch: 'full' },
    { path: 'login', component: LoginComponent },
    { path: 'setup', loadComponent: () => import('./setup/setup.component').then(m => m.SetupComponent) },
    { path: 'recover', loadComponent: () => import('./login/recovery/recovery.component').then(m => m.RecoveryComponent) },
    { path: 'change-password', loadComponent: () => import('./login/change-password/change-password.component').then(m => m.ChangePasswordComponent) },
    {
        path: '',
        canActivate: [authGuard],
        loadComponent: () => import('./layout/main-layout/main-layout.component').then(m => m.MainLayoutComponent),
        children: [
            { path: 'dashboard', component: DashboardComponent },
            { path: 'patients', loadComponent: () => import('./patients/patient-list/patient-list.component').then(m => m.PatientListComponent) },
            { path: 'patients/:id', loadComponent: () => import('./patients/patient-details/patient-details.component').then(m => m.PatientDetailsComponent) },
            { path: 'visits', loadComponent: () => import('./visits/visit-list/visit-list.component').then(m => m.VisitListComponent) },
            { path: 'visit/:id', loadComponent: () => import('./visits/visit/visit.component').then(m => m.VisitComponent) },
            { path: 'online-booking', loadComponent: () => import('./online-booking/online-booking.component').then(m => m.OnlineBookingComponent) },
            { path: 'settings', loadComponent: () => import('./settings/settings.component').then(m => m.SettingsComponent), canActivate: [adminGuard] },
            { path: 'profile', loadComponent: () => import('./profile/profile.component').then(m => m.ProfileComponent) },
            { path: 'queue', loadComponent: () => import('./queue/queue.component').then(m => m.QueueComponent) }
        ]
    }
];
