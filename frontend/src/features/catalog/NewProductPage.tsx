import { Paper, Stack, Title } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { ProductForm } from './components/ProductForm';
import { createProduct } from './api';
import type { ProductFormValues } from './api';

export function NewProductPage() {
  const navigate = useNavigate();

  const handleSubmit = async (values: ProductFormValues): Promise<void> => {
    const product = await createProduct(values);
    void navigate(`/catalogo/productos/${product.id}`);
  };

  return (
    <Stack maw={480}>
      <Title order={3}>Nuevo producto</Title>
      <Paper withBorder p="md">
        <ProductForm submitLabel="Crear producto" onSubmit={handleSubmit} />
      </Paper>
    </Stack>
  );
}
