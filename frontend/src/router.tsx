import { createBrowserRouter, Navigate } from 'react-router-dom';
import { LoginPage } from './features/auth/LoginPage';
import { RequireAuth } from './features/auth/RequireAuth';
import { RequireOwner } from './features/auth/RequireOwner';
import { AppLayout } from './layouts/AppLayout';
import { CatalogPage } from './features/catalog/CatalogPage';
import { NewProductPage } from './features/catalog/NewProductPage';
import { ProductDetailPage } from './features/catalog/ProductDetailPage';
import { VariantGridPage } from './features/catalog/VariantGridPage';
import { NewVariantPage } from './features/catalog/NewVariantPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/', element: <Navigate to="/catalogo" replace /> },
          { path: '/catalogo', element: <CatalogPage /> },
          { path: '/catalogo/productos/nuevo', element: <NewProductPage /> },
          {
            path: '/catalogo/productos/:productId',
            element: <ProductDetailPage />,
          },
          {
            element: <RequireOwner />,
            children: [
              {
                path: '/catalogo/productos/:productId/grilla',
                element: <VariantGridPage />,
              },
              {
                path: '/catalogo/productos/:productId/variantes/nueva',
                element: <NewVariantPage />,
              },
            ],
          },
        ],
      },
    ],
  },
]);
