import type { RouteObject } from 'react-router';
import { Reader } from './Reader';

export const readerBareRoutes: RouteObject[] = [{ path: '/read/:releaseId', element: <Reader /> }];
