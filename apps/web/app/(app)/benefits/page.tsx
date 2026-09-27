import { HRModuleClient } from '@/components/hr/hr-module-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export default async function BenefitsPage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return (
        <HRModuleClient
            namespace="hr.benefits"
            endpoint="/api/proxy/hr/benefit-plans"
            columns={[
                { key: 'name', label: 'Name' },
                { key: 'category', label: 'Category' },
                { key: 'provider', label: 'Provider' },
                { key: 'cost', label: 'Cost' },
                { key: 'currency', label: 'Currency' },
                { key: 'status', label: 'Status' }
            ]}
            formFields={[
                { key: 'name', label: 'Name' },
                { key: 'description', label: 'Description', type: 'textarea' },
                { key: 'category', label: 'Category' },
                { key: 'provider', label: 'Provider' },
                { key: 'cost', label: 'Cost', type: 'number' },
                { key: 'currency', label: 'Currency' },
                { key: 'status', label: 'Status', type: 'select', options: ['active', 'inactive', 'discontinued'] }
            ]}
        />
    );
}
