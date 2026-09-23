import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Settings hosts user management and vault controls: admins only. */
export const adminGuard: CanActivateFn = (route, state) => {
    const authService = inject(AuthService);
    const router = inject(Router);

    if (authService.isLoggedIn() && authService.getUser()?.role === 'admin') {
        return true;
    }

    return router.createUrlTree(['/dashboard']);
};
