import { useEffect, useState } from 'react';
import { Entity } from '@backstage/catalog-model';
import {
  Progress,
  Table,
  TableColumn,
  WarningPanel,
} from '@backstage/core-components';
import { identityApiRef, useApi } from '@backstage/frontend-plugin-api';
import { catalogApiRef, EntityRefLink } from '@backstage/plugin-catalog-react';

/**
 * Components owned by the signed-in user or any of their groups
 * (identity ownershipEntityRefs, matched against the catalog's ownedBy relations).
 */
export const MyServices = () => {
  const catalogApi = useApi(catalogApiRef);
  const identityApi = useApi(identityApiRef);
  const [entities, setEntities] = useState<Entity[]>();
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { ownershipEntityRefs } = await identityApi.getBackstageIdentity();
      const { items } = await catalogApi.getEntities({
        filter: {
          kind: 'Component',
          'relations.ownedBy': ownershipEntityRefs,
        },
        fields: [
          'kind',
          'metadata.name',
          'metadata.namespace',
          'metadata.title',
          'spec.type',
          'spec.lifecycle',
          'spec.owner',
        ],
      });
      if (!cancelled) {
        setEntities(
          items.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
        );
      }
    })().catch(e => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [catalogApi, identityApi]);

  if (error) {
    return <WarningPanel title="Could not load your services" message={error.message} />;
  }
  if (!entities) {
    return <Progress />;
  }

  const columns: TableColumn<Entity>[] = [
    {
      title: 'Service',
      render: entity => <EntityRefLink entityRef={entity} />,
    },
    { title: 'Type', render: entity => String(entity.spec?.type ?? '') },
    { title: 'Lifecycle', render: entity => String(entity.spec?.lifecycle ?? '') },
    { title: 'Owner', render: entity => String(entity.spec?.owner ?? '') },
  ];

  return (
    <Table<Entity>
      options={{ paging: false, search: false, toolbar: false, padding: 'dense' }}
      columns={columns}
      data={entities}
      emptyContent={<>You don't own any services yet. Create one with the golden path.</>}
    />
  );
};
