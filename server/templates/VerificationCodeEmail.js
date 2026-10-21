import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Html, Head, Preview, Body, Container, Section, Heading, Text, Hr, } from '@react-email/components';
const mainStyle = {
    backgroundColor: '#f4f4f5',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    margin: '0',
    padding: '24px 0',
};
const containerStyle = {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    border: '1px solid #e4e4e7',
    maxWidth: '560px',
    margin: '0 auto',
    padding: '32px 28px',
};
const headerSection = {
    borderBottom: '2px solid #800000',
    paddingBottom: '16px',
    marginBottom: '24px',
};
const headerTitle = {
    color: '#800000',
    fontSize: '24px',
    fontWeight: '700',
    letterSpacing: '-0.5px',
    margin: '0 0 4px 0',
};
const headerSubtitle = {
    color: '#71717a',
    fontSize: '13px',
    fontWeight: '500',
    margin: '0',
};
const greetingText = {
    color: '#18181b',
    fontSize: '16px',
    margin: '0 0 16px 0',
};
const bodyText = {
    color: '#3f3f46',
    fontSize: '15px',
    lineHeight: '1.5',
    margin: '0 0 20px 0',
};
const codeContainer = {
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '8px',
    textAlign: 'center',
    padding: '18px',
    margin: '24px 0',
};
const codeText = {
    color: '#800000',
    fontSize: '32px',
    fontWeight: '800',
    letterSpacing: '8px',
    margin: '0',
};
const expiryText = {
    color: '#71717a',
    fontSize: '13px',
    lineHeight: '1.4',
    margin: '0 0 24px 0',
};
const hrStyle = {
    borderColor: '#e4e4e7',
    margin: '24px 0 16px 0',
};
const footerText = {
    color: '#a1a1aa',
    fontSize: '12px',
    lineHeight: '1.4',
    margin: '0',
    textAlign: 'center',
};
export function VerificationCodeEmail({ fullName, code, expiresInMinutes = 10, }) {
    return (_jsxs(Html, { lang: "en", children: [_jsx(Head, {}), _jsxs(Preview, { children: ["Your EARIST Gate Pass verification code: ", code] }), _jsx(Body, { style: mainStyle, children: _jsxs(Container, { style: containerStyle, children: [_jsxs(Section, { style: headerSection, children: [_jsx(Heading, { style: headerTitle, children: "EARIST E-GatePass" }), _jsx(Text, { style: headerSubtitle, children: "Eulogio \"Amang\" Rodriguez Institute of Science and Technology" })] }), _jsxs(Section, { children: [_jsxs(Text, { style: greetingText, children: ["Hello ", _jsx("strong", { children: fullName }), ","] }), _jsx(Text, { style: bodyText, children: "Enter this 6-digit verification code to confirm ownership of your email address for your digital gate pass:" }), _jsx(Section, { style: codeContainer, children: _jsx(Text, { style: codeText, children: code }) }), _jsx(Text, { style: expiryText, children: `This code will expire in ${expiresInMinutes} minutes. If you did not request this pass, please disregard this email.` })] }), _jsx(Hr, { style: hrStyle }), _jsx(Section, { children: _jsx(Text, { style: footerText, children: "Automated verification from the EARIST Visitor Management System. Please do not reply directly to this email." }) })] }) })] }));
}
export default VerificationCodeEmail;
