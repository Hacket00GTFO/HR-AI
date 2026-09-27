import { HRModuleClient } from '@/components/hr/hr-module-client';
import { AccessDenied } from '@/components/access-denied';
import { getSessionUser } from '@/lib/session';

export default async function EmployeesPage() {
    const user = await getSessionUser();
    if (user?.role !== 'hr') return <AccessDenied />;
    return (
        <HRModuleClient
            namespace="hr.employees"
            endpoint="/api/proxy/hr/employees"
            columns={[
                { key: 'employee_number', label: 'Employee #' },
                { key: 'first_name', label: 'First Name' },
                { key: 'last_name', label: 'Last Name' },
                { key: 'email', label: 'Email' },
                { key: 'department', label: 'Department' },
                { key: 'position', label: 'Position' },
                { key: 'legal_entity', label: 'Legal Entity' },
                { key: 'site', label: 'Site' },
                { key: 'status', label: 'Status' }
            ]}
            formFields={[
                { key: 'employee_number', label: 'Employee #' },
                { key: 'first_name', label: 'First Name' },
                { key: 'last_name', label: 'Last Name' },
                { key: 'email', label: 'Email' },
                { key: 'phone', label: 'Phone' },
                { key: 'rfc', label: 'RFC' },
                { key: 'curp', label: 'CURP' },
                { key: 'nss', label: 'NSS' },
                { key: 'legal_entity', label: 'Legal Entity' },
                { key: 'site', label: 'Site' },
                { key: 'department', label: 'Department' },
                { key: 'position', label: 'Position' },
                {
                    key: 'employment_type',
                    label: 'Employment Type',
                    type: 'select',
                    options: ['full_time', 'part_time', 'contract', 'intern']
                },
                { key: 'hire_date', label: 'Hire Date', type: 'date' },
                { key: 'salary', label: 'Salary', type: 'number' },
                { key: 'currency', label: 'Currency' },
                { key: 'location', label: 'Location' },
                {
                    key: 'status',
                    label: 'Status',
                    type: 'select',
                    options: ['active', 'on_leave', 'terminated', 'resigned']
                }
            ]}
        />
    );
}
